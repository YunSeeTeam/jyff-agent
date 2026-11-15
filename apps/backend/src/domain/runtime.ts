import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  type ConfigurationDependencyIssue,
  configurationDependencyIssues,
  defaultRunSettings,
  mergeRunSettings,
  type OptimizationCapability,
  type RunSettings,
  type RunSettingsPatch,
} from "@ctf-agent/core/contracts"
import type {
  AgentModelBindings,
  DashboardProjectRuntimeConfiguration,
  ProjectRuntimeConfigurationUpdate,
  ProjectRuntimeConfigurationView,
} from "../types.ts"
import { parseStoredRunSettings } from "./run-settings-schema.ts"

/**
 * Version 1 files written before the run settings existed lack them and the
 * revision; they read as defaults. Older binaries ignore the added fields.
 */
interface StoredProjectRuntimeConfiguration extends AgentModelBindings, RunSettings {
  version: 1
  maxConcurrent: number
  maxRemoteEnvironments: number
  revision: number
}

/** The update was based on a stale snapshot. */
export class RuntimeConfigurationConflictError extends Error {
  readonly code = "runtime_configuration_conflict"
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Project 运行配置已被其他修改更新（当前版本 ${currentRevision}，提交基于 ${expectedRevision}），请刷新后重试`,
    )
    this.name = "RuntimeConfigurationConflictError"
  }
}

/** A switch cannot be enabled in this build or without its prerequisites. */
export class ConfigurationDependencyError extends Error {
  readonly code = "configuration_dependency_error"
  constructor(readonly issues: readonly ConfigurationDependencyIssue[]) {
    super(issues.map((issue) => issue.message).join("; "))
    this.name = "ConfigurationDependencyError"
  }
}

type RuntimeConfigurationFallback = Omit<
  ProjectRuntimeConfigurationView,
  "revision" | keyof RunSettings
>

export async function createFileProjectRuntimeConfiguration(options: {
  storagePath: string
  fallback: RuntimeConfigurationFallback
  availableModelIds: () => ReadonlySet<string>
  /** Optimization capabilities this build provides; none until stage 3 ships them. */
  availableCapabilities?: () => ReadonlySet<OptimizationCapability>
}): Promise<DashboardProjectRuntimeConfiguration> {
  const capabilities = options.availableCapabilities ?? (() => new Set<OptimizationCapability>())
  const stored = await readConfiguration(options.storagePath, options.fallback)
  validateConfiguration(stored, options.availableModelIds())
  let current = stored
  return {
    snapshot: () => publicView(current),
    update: async (configuration) => {
      if (
        configuration.expectedRevision !== undefined &&
        configuration.expectedRevision !== current.revision
      ) {
        throw new RuntimeConfigurationConflictError(
          configuration.expectedRevision,
          current.revision,
        )
      }
      const next: StoredProjectRuntimeConfiguration = {
        version: 1,
        solverModelId: configuration.solverModelId,
        tldrModelId: configuration.tldrModelId,
        subagentModels: { ...configuration.subagentModels },
        maxConcurrent: configuration.maxConcurrent,
        maxRemoteEnvironments: configuration.maxRemoteEnvironments,
        ...mergeRunSettings(current, runSettingsPatch(configuration)),
        revision: current.revision + 1,
      }
      validateConfiguration(next, options.availableModelIds())
      const issues = configurationDependencyIssues(next, capabilities())
      if (issues.length > 0) throw new ConfigurationDependencyError(issues)
      await persist(options.storagePath, next)
      current = next
      return publicView(current)
    },
  }
}

function runSettingsPatch(update: ProjectRuntimeConfigurationUpdate): RunSettingsPatch {
  return {
    ...(update.optimization ? { optimization: update.optimization } : {}),
    ...(update.skills ? { skills: update.skills } : {}),
  }
}

async function readConfiguration(
  path: string,
  fallback: RuntimeConfigurationFallback,
): Promise<StoredProjectRuntimeConfiguration> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { version: 1, ...fallback, ...defaultRunSettings(), revision: 0 }
    }
    throw new Error(`无法读取 Project 运行配置: ${path}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error(`Project 运行配置格式无效: ${path}`)
  }
  return {
    version: 1,
    solverModelId: stringValue(parsed.solverModelId),
    tldrModelId: stringValue(parsed.tldrModelId),
    subagentModels: stringRecord(parsed.subagentModels),
    maxConcurrent: Number(parsed.maxConcurrent),
    maxRemoteEnvironments:
      parsed.maxRemoteEnvironments === undefined
        ? fallback.maxRemoteEnvironments
        : Number(parsed.maxRemoteEnvironments),
    ...storedRunSettings(parsed, path),
    revision: parsed.revision === undefined ? 0 : Number(parsed.revision),
  }
}

/** Read stored run settings through the same merge as updates; unknown keys are ignored. */
function storedRunSettings(parsed: Record<string, unknown>, path: string): RunSettings {
  const patch = parseStoredRunSettings({
    optimization: parsed.optimization,
    skills: parsed.skills,
  })
  if (!patch) throw new Error(`Project 运行配置中的优化设置无效: ${path}`)
  return mergeRunSettings(defaultRunSettings(), patch)
}

function validateConfiguration(
  configuration: StoredProjectRuntimeConfiguration,
  modelIds: ReadonlySet<string>,
): void {
  if (
    !Number.isInteger(configuration.maxConcurrent) ||
    configuration.maxConcurrent < 1 ||
    configuration.maxConcurrent > 64
  ) {
    throw new Error("maxConcurrent 必须是 1–64 的整数")
  }
  if (
    !Number.isInteger(configuration.maxRemoteEnvironments) ||
    configuration.maxRemoteEnvironments < 1 ||
    configuration.maxRemoteEnvironments > 64
  ) {
    throw new Error("maxRemoteEnvironments 必须是 1–64 的整数")
  }
  if (!Number.isInteger(configuration.revision) || configuration.revision < 0) {
    throw new Error("Project 运行配置版本号无效")
  }
  if (modelIds.size === 0) {
    if (
      configuration.solverModelId ||
      configuration.tldrModelId ||
      Object.keys(configuration.subagentModels).length > 0
    ) {
      throw new Error("空模型池不能包含 Project 模型绑定")
    }
    return
  }
  if (!modelIds.has(configuration.solverModelId)) {
    throw new Error(`Solver 模型不存在: ${configuration.solverModelId}`)
  }
  if (configuration.tldrModelId && !modelIds.has(configuration.tldrModelId)) {
    throw new Error(`TLDR 模型不存在: ${configuration.tldrModelId}`)
  }
  for (const [role, modelId] of Object.entries(configuration.subagentModels)) {
    if (!role.trim() || !modelIds.has(modelId)) {
      throw new Error(`SubAgent ${role || "<empty>"} 的模型不存在: ${modelId}`)
    }
  }
}

async function persist(
  path: string,
  configuration: StoredProjectRuntimeConfiguration,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function publicView(
  configuration: StoredProjectRuntimeConfiguration,
): ProjectRuntimeConfigurationView {
  const settings = mergeRunSettings(configuration, {})
  return {
    solverModelId: configuration.solverModelId,
    tldrModelId: configuration.tldrModelId,
    subagentModels: { ...configuration.subagentModels },
    maxConcurrent: configuration.maxConcurrent,
    maxRemoteEnvironments: configuration.maxRemoteEnvironments,
    optimization: settings.optimization,
    skills: settings.skills,
    revision: configuration.revision,
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([key, entryValue]) =>
          [key.trim(), typeof entryValue === "string" ? entryValue.trim() : ""] as const,
      )
      .filter(([key, entryValue]) => Boolean(key) && Boolean(entryValue)),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
