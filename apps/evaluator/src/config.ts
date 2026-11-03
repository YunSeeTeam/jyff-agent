import { readFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

/** USD per one million tokens. */
export interface PricingRate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface BackendConfig {
  /** Checkout of the jyff-agent revision under test. */
  cwd: string
  /** Executable and leading arguments; --root/--host/--port are appended. */
  command: string[]
  host: string
  port: number
  /** Fixed backend options for this group, e.g. --max-attempts. */
  extraArgs: string[]
}

export interface EvaluationConfig {
  /** Comparison group label, e.g. "A-original". */
  group: string
  /** Configured data root whose .ctf-agent holds platform, model and secrets. */
  templateRoot: string
  outputDir: string
  projectId: string
  challenges: Array<{ id: string; label?: string }>
  repeats: number
  /** Strict wall clock per sample, measured from dispatch. */
  wallClockMs: number
  /** How long to keep observing writeup/cleanup after the first accepted submission. */
  postAcceptGraceMs: number
  cancelGraceMs: number
  readyTimeoutMs: number
  pollIntervalMs: number
  /**
   * A sample is finished only after no Run is active and nothing is queued for
   * this long. Baseline retries are scheduled in memory, so the database can
   * look idle between attempts; keep this above the backend --retry-delay-ms.
   */
  idleSettleMs: number
  backend: BackendConfig
  /** Optional command run before each sample to restore the platform's unsolved state. */
  resetCommand?: string[]
  webUiLogin?: { username: string; passwordEnv: string }
  /** Keyed by "provider/model". Missing models fall back to session cost, else stay unpriced. */
  pricing: Record<string, PricingRate>
  removeLeftoverContainers: boolean
}

export class EvaluationConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvaluationConfigError"
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(source: JsonObject, key: string, path: string): string {
  const value = source[key]
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvaluationConfigError(`${path}${key} 必须是非空字符串`)
  }
  return value
}

function optionalInteger(
  source: JsonObject,
  key: string,
  fallback: number,
  min: number,
  path = "",
): number {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new EvaluationConfigError(`${path}${key} 必须是不小于 ${min} 的整数`)
  }
  return value
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EvaluationConfigError(`${path} 必须是字符串数组`)
  }
  return [...(value as string[])]
}

function parsePricing(value: unknown): Record<string, PricingRate> {
  if (value === undefined) return {}
  if (!isObject(value)) throw new EvaluationConfigError("pricing 必须是对象")
  const pricing: Record<string, PricingRate> = {}
  for (const [model, rate] of Object.entries(value)) {
    if (!model.includes("/")) {
      throw new EvaluationConfigError(`pricing 键必须是 provider/model：${model}`)
    }
    if (!isObject(rate)) throw new EvaluationConfigError(`pricing.${model} 必须是对象`)
    const field = (key: keyof PricingRate): number => {
      const amount = rate[key] ?? 0
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
        throw new EvaluationConfigError(`pricing.${model}.${key} 必须是非负数`)
      }
      return amount
    }
    pricing[model] = {
      input: field("input"),
      output: field("output"),
      cacheRead: field("cacheRead"),
      cacheWrite: field("cacheWrite"),
    }
  }
  return pricing
}

/** Validate a parsed config; relative paths resolve against baseDirectory. */
export function parseEvaluationConfig(value: unknown, baseDirectory: string): EvaluationConfig {
  if (!isObject(value)) throw new EvaluationConfigError("配置必须是 JSON 对象")

  const challengesValue = value.challenges
  if (!Array.isArray(challengesValue) || challengesValue.length === 0) {
    throw new EvaluationConfigError("challenges 至少包含一道题")
  }
  const seen = new Set<string>()
  const challenges = challengesValue.map((item, index) => {
    const entry = typeof item === "string" ? { id: item } : item
    if (!isObject(entry)) throw new EvaluationConfigError(`challenges[${index}] 必须是字符串或对象`)
    const id = requiredString(entry, "id", `challenges[${index}].`)
    if (seen.has(id)) throw new EvaluationConfigError(`challenges 中重复的题目：${id}`)
    seen.add(id)
    const label = entry.label
    if (label !== undefined && typeof label !== "string") {
      throw new EvaluationConfigError(`challenges[${index}].label 必须是字符串`)
    }
    return label === undefined ? { id } : { id, label }
  })

  const backendValue = value.backend ?? {}
  if (!isObject(backendValue)) throw new EvaluationConfigError("backend 必须是对象")
  const backendCwd = backendValue.cwd
  if (typeof backendCwd !== "string" || backendCwd.trim() === "") {
    throw new EvaluationConfigError("backend.cwd 必须指向被测 jyff-agent 检出目录")
  }
  const backend: BackendConfig = {
    cwd: resolve(baseDirectory, backendCwd),
    command:
      backendValue.command === undefined
        ? [process.execPath, "--experimental-transform-types", "apps/backend/src/main.ts"]
        : stringArray(backendValue.command, "backend.command"),
    host: typeof backendValue.host === "string" ? backendValue.host : "127.0.0.1",
    port: optionalInteger(backendValue, "port", 3_900, 1, "backend."),
    extraArgs:
      backendValue.extraArgs === undefined
        ? []
        : stringArray(backendValue.extraArgs, "backend.extraArgs"),
  }
  if (backend.command.length === 0) throw new EvaluationConfigError("backend.command 不能为空")
  for (const reserved of ["--root", "--host", "--port", "--auto-start"]) {
    if (backend.extraArgs.includes(reserved)) {
      throw new EvaluationConfigError(`backend.extraArgs 不能包含评测器管理的 ${reserved}`)
    }
  }

  let webUiLogin: EvaluationConfig["webUiLogin"]
  if (value.webUiLogin !== undefined) {
    if (!isObject(value.webUiLogin)) throw new EvaluationConfigError("webUiLogin 必须是对象")
    webUiLogin = {
      username: requiredString(value.webUiLogin, "username", "webUiLogin."),
      passwordEnv: requiredString(value.webUiLogin, "passwordEnv", "webUiLogin."),
    }
  }

  const wallClockMs = value.wallClockMs
  if (typeof wallClockMs !== "number" || !Number.isSafeInteger(wallClockMs) || wallClockMs < 1) {
    throw new EvaluationConfigError("wallClockMs 必须显式给出正整数（严格整题墙钟）")
  }
  const removeLeftoverContainers = value.removeLeftoverContainers ?? true
  if (typeof removeLeftoverContainers !== "boolean") {
    throw new EvaluationConfigError("removeLeftoverContainers 必须是布尔值")
  }
  // Sample roots carry copies of the template secrets.
  const outputDir = resolve(baseDirectory, requiredString(value, "outputDir", ""))
  const fromCheckout = relative(backend.cwd, outputDir)
  if (fromCheckout === "" || (!fromCheckout.startsWith("..") && !isAbsolute(fromCheckout))) {
    throw new EvaluationConfigError(
      "outputDir 不能位于被测仓库内：样本数据根包含 secrets.json 副本",
    )
  }

  return {
    group: requiredString(value, "group", ""),
    templateRoot: resolve(baseDirectory, requiredString(value, "templateRoot", "")),
    outputDir,
    projectId: requiredString(value, "projectId", ""),
    challenges,
    repeats: optionalInteger(value, "repeats", 3, 1),
    wallClockMs,
    postAcceptGraceMs: optionalInteger(value, "postAcceptGraceMs", 10 * 60_000, 0),
    cancelGraceMs: optionalInteger(value, "cancelGraceMs", 60_000, 0),
    readyTimeoutMs: optionalInteger(value, "readyTimeoutMs", 120_000, 1),
    pollIntervalMs: optionalInteger(value, "pollIntervalMs", 2_000, 10),
    idleSettleMs: optionalInteger(value, "idleSettleMs", 60_000, 0),
    backend,
    ...(value.resetCommand === undefined
      ? {}
      : { resetCommand: stringArray(value.resetCommand, "resetCommand") }),
    ...(webUiLogin ? { webUiLogin } : {}),
    pricing: parsePricing(value.pricing),
    removeLeftoverContainers,
  }
}

export async function loadEvaluationConfig(path: string): Promise<EvaluationConfig> {
  const absolute = resolve(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"))
  } catch (error) {
    throw new EvaluationConfigError(
      `无法读取评测配置 ${absolute}：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseEvaluationConfig(parsed, dirname(absolute))
}
