import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type AgentRuntimeProfile,
  type AgentSkill,
  agentRuntimeProfile,
  resumableSessionFormats,
  type SubagentRole,
  supportedThinkingLevels,
} from "@ctf-agent/agents"
import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { Api, Model } from "@earendil-works/pi-ai"
import {
  type OptimizationCapability,
  type RunSettings,
  resolveSkillSelection,
  skillSelectionForRole,
} from "../contracts/index.ts"
import { RUN_STORE_DATA_CAPABILITIES } from "../persistence/run-store.ts"

/**
 * Optional capabilities this build provides. Empty until stage 3 ships the
 * information contracts; every switch therefore stays off.
 */
export const BUILD_OPTIMIZATION_CAPABILITIES: ReadonlySet<OptimizationCapability> = new Set()

export const RUN_CONFIG_SNAPSHOT_FILE = "run-config.json"

export interface RuntimeProfile extends AgentRuntimeProfile {
  /** SHA-256 of the installed pnpm-lock.yaml, or "unknown" when it is not shipped. */
  lockfileSha256: string
  runStoreCapabilities: Record<string, number>
  optimizationCapabilities: string[]
}

/**
 * `new_run`: frozen from the Project settings before the Run first started.
 * `legacy_resume`: the Run started before snapshots existed. It ran with every
 * switch off and keeps doing so; the runtime profile is the one resuming it,
 * since from then on that runtime writes its session.
 */
export type RunConfigOrigin = "new_run" | "legacy_resume"

export interface RunConfigSnapshot {
  schemaVersion: 1
  runId: string
  challengeId: string
  frozenAt: string
  origin: RunConfigOrigin
  settings: RunSettings
  /** Skill names each agent may see after expanding `all` against the discovered skills. */
  skills: {
    solver: string[]
    subagentDefault: string[]
    subagentRoles: Record<string, string[]>
  }
  subagentRoles: Array<{
    name: string
    source: string
    enabled: boolean
    tools: string[] | "all"
    model: string | null
    thinkingLevel: ThinkingLevel
    systemPromptSha256: string
  }>
  /** Null when the Run was created without a configured model. */
  model: {
    provider: string
    id: string
    api: string
    /** Scheme and host only; paths and query strings can carry credentials. */
    endpoint: string | null
    contextWindow: number
    maxTokens: number
    reasoning: boolean
    thinkingLevel: ThinkingLevel
    supportedThinkingLevels: ThinkingLevel[]
  } | null
  limits: {
    sandboxPrivileged: boolean
    sandboxNetworkMode: string
  }
  runtimeProfile: RuntimeProfile
}

/** Raised before a Run starts when its frozen configuration cannot be honored. */
export class RunConfigurationError extends Error {
  /** Only an operator can fix the Project settings; schedulers must not retry or block on it. */
  readonly requiresConfiguration = true

  constructor(
    readonly code: "configuration_dependency_error" | "capability_unavailable",
    message: string,
  ) {
    super(message)
    this.name = "RunConfigurationError"
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** JSON with object keys sorted, so equal configurations hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** Hash of what the Run was configured with; Run identity and freeze time are excluded. */
export function runConfigHash(snapshot: RunConfigSnapshot): string {
  const {
    runId: _runId,
    challengeId: _challengeId,
    frozenAt: _frozenAt,
    ...configuration
  } = snapshot
  return `v1:${sha256(canonicalJson(configuration))}`
}

let lockfileHash: Promise<string> | undefined

function installedLockfileSha256(): Promise<string> {
  lockfileHash ??= (async () => {
    let directory = dirname(fileURLToPath(import.meta.url))
    for (;;) {
      const candidate = join(directory, "pnpm-lock.yaml")
      if (existsSync(candidate)) return sha256(await readFile(candidate, "utf8"))
      const parent = dirname(directory)
      if (parent === directory) return "unknown"
      directory = parent
    }
  })()
  return lockfileHash
}

export async function currentRuntimeProfile(): Promise<RuntimeProfile> {
  return {
    ...agentRuntimeProfile(),
    lockfileSha256: await installedLockfileSha256(),
    runStoreCapabilities: { ...RUN_STORE_DATA_CAPABILITIES },
    optimizationCapabilities: [...BUILD_OPTIMIZATION_CAPABILITIES].sort(),
  }
}

function endpointOrigin(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null
  try {
    return new URL(baseUrl).origin
  } catch {
    return null
  }
}

function unknownSkillsError(agent: string, unknown: readonly string[]): RunConfigurationError {
  return new RunConfigurationError(
    "configuration_dependency_error",
    `${agent} 选择了不存在的 Skill: ${unknown.join(", ")}`,
  )
}

export interface BuildRunConfigSnapshotInput {
  runId: string
  challengeId: string
  settings: RunSettings
  skills: readonly AgentSkill[]
  subagentRoles: ReadonlyMap<string, SubagentRole>
  model: Model<Api> | undefined
  thinkingLevel: ThinkingLevel
  sandbox: { privileged: boolean; networkMode: string }
  /** Defaults to `new_run`. */
  origin?: RunConfigOrigin
}

/** Freeze the configuration a new Run starts with. Unknown skill names fail the Run before it starts. */
export async function buildRunConfigSnapshot(
  input: BuildRunConfigSnapshotInput,
): Promise<RunConfigSnapshot> {
  const available = input.skills.map((skill) => skill.name)
  const solver = resolveSkillSelection(input.settings.skills.solver, available)
  if (solver.unknown.length > 0) throw unknownSkillsError("Solver", solver.unknown)
  const subagentDefault = resolveSkillSelection(input.settings.skills.subagents.default, available)
  if (subagentDefault.unknown.length > 0) {
    throw unknownSkillsError("SubAgent 默认", subagentDefault.unknown)
  }
  const subagentRoles: Record<string, string[]> = {}
  for (const role of Object.keys(input.settings.skills.subagents.roles)) {
    if (!input.subagentRoles.has(role)) {
      throw new RunConfigurationError(
        "configuration_dependency_error",
        `Skill 选择引用了不存在的 SubAgent 角色: ${role}`,
      )
    }
    const resolved = resolveSkillSelection(
      skillSelectionForRole(input.settings.skills, role),
      available,
    )
    if (resolved.unknown.length > 0) throw unknownSkillsError(`SubAgent ${role}`, resolved.unknown)
    subagentRoles[role] = resolved.names
  }
  return {
    schemaVersion: 1,
    runId: input.runId,
    challengeId: input.challengeId,
    frozenAt: new Date().toISOString(),
    origin: input.origin ?? "new_run",
    settings: structuredClone(input.settings),
    skills: { solver: solver.names, subagentDefault: subagentDefault.names, subagentRoles },
    subagentRoles: [...input.subagentRoles.values()]
      .map((role) => ({
        name: role.name,
        source: role.source,
        enabled: role.enabled,
        tools: role.tools ? [...role.tools] : ("all" as const),
        model: role.model ?? null,
        thinkingLevel: role.thinkingLevel,
        systemPromptSha256: sha256(role.systemPrompt),
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
    model: input.model
      ? {
          provider: input.model.provider,
          id: input.model.id,
          api: input.model.api,
          endpoint: endpointOrigin(input.model.baseUrl),
          contextWindow: input.model.contextWindow,
          maxTokens: input.model.maxTokens,
          reasoning: input.model.reasoning,
          thinkingLevel: input.thinkingLevel,
          supportedThinkingLevels: supportedThinkingLevels(input.model),
        }
      : null,
    limits: {
      sandboxPrivileged: input.sandbox.privileged,
      sandboxNetworkMode: input.sandbox.networkMode,
    },
    runtimeProfile: await currentRuntimeProfile(),
  }
}

/** Publish the snapshot atomically next to the Run's session. */
export async function writeRunConfigSnapshot(
  runDirectory: string,
  snapshot: RunConfigSnapshot,
): Promise<{ path: string; configHash: string }> {
  const path = join(runDirectory, RUN_CONFIG_SNAPSHOT_FILE)
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await mkdir(runDirectory, { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return { path, configHash: runConfigHash(snapshot) }
}

export async function readRunConfigSnapshot(
  runDirectory: string,
): Promise<RunConfigSnapshot | undefined> {
  const path = join(runDirectory, RUN_CONFIG_SNAPSHOT_FILE)
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(await readFile(path, "utf8")) as RunConfigSnapshot
  if (parsed.schemaVersion !== 1) {
    throw new RunConfigurationError(
      "capability_unavailable",
      `Run 配置快照版本不受支持: ${String(parsed.schemaVersion)}`,
    )
  }
  return parsed
}

/** A resumed Run must keep the runtime it started with; it never switches halfway. */
export function assertResumableRuntime(snapshot: RunConfigSnapshot): void {
  const format = snapshot.runtimeProfile.sessionFormat
  if (!resumableSessionFormats().has(format)) {
    throw new RunConfigurationError(
      "capability_unavailable",
      `当前运行时无法恢复会话格式 ${format}（Run 由 ${snapshot.runtimeProfile.adapterId} 创建）`,
    )
  }
}
