import { execFile, spawn } from "node:child_process"
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  type ApiResult,
  type BackendApi,
  type BackendExit,
  type BackendHandle,
  type BackendLauncher,
  httpBackendApi,
  processBackendLauncher,
} from "./backend.ts"
import { collectSample, readRunState, type SampleObservation } from "./collect.ts"
import type { EvaluationConfig } from "./config.ts"
import { cloneTemplateRoot, projectStateDirectory, templateFingerprint } from "./sample-root.ts"

const execFileAsync = promisify(execFile)

export type SampleOutcome =
  /** First platform acceptance at or before the strict deadline. */
  | "accepted"
  /** Accepted, but only after the deadline; not an on-time success. */
  | "accepted_late"
  | "not_accepted"
  /** The platform already considered the challenge solved: the sample was not isolated. */
  | "isolation_failed"
  | "harness_error"

export type StopReason =
  | "accepted"
  | "finished"
  | "deadline"
  | "backend_exited"
  | "aborted"
  | "harness_error"

export interface HarnessError {
  step: string
  code: string
  message: string
}

export interface SampleResult {
  schemaVersion: 1
  group: string
  sampleId: string
  challengeId: string
  challengeLabel?: string
  repeat: number
  order: number
  outcome: SampleOutcome
  stopReason: StopReason
  startedAt: string
  dispatchedAt: string | null
  deadlineAt: string | null
  stoppedAt: string
  timeToAcceptMs: number | null
  harnessErrors: HarnessError[]
  cancel: { requestedAt: string; result: ApiResult } | null
  backendExit: BackendExit | null
  leftoverContainers: { found: number; removed: number }
  /** Contains a copy of the template secrets; keep outside version control. */
  sampleRoot: string
  observation: SampleObservation | null
}

export interface EnvironmentIdentity {
  evaluatorNode: string
  platform: string
  backendGit: { commit: string | null; dirty: boolean | null }
  solverImageId: string | null
}

export interface EvaluationDeps {
  launcher: BackendLauncher
  connect(baseUrl: string): BackendApi
  now(): number
  sleep(ms: number): Promise<void>
  runCommand(
    command: string[],
    env: Record<string, string>,
    cwd: string,
  ): Promise<{ code: number | null; output: string }>
  listRunContainers(runIds: string[]): Promise<string[]>
  removeContainers(ids: string[]): Promise<void>
  environment(config: EvaluationConfig): Promise<EnvironmentIdentity>
  log(message: string): void
}

const MAX_COMMAND_OUTPUT = 64 * 1024
const BACKEND_STOP_GRACE_MS = 15_000

/** A failure in one step of a sample; recorded, never thrown out of runSample. */
class SampleStepError extends Error {
  constructor(
    readonly step: string,
    readonly code: string,
    message: string,
    readonly stopReason: StopReason = "harness_error",
  ) {
    super(message)
    this.name = "SampleStepError"
  }
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 48) || "challenge"
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Interleave repeats so each round starts from a different challenge. */
export function sampleOrder(
  config: Pick<EvaluationConfig, "challenges" | "repeats" | "group">,
): Array<{
  sampleId: string
  challenge: EvaluationConfig["challenges"][number]
  repeat: number
  order: number
}> {
  const plan = []
  const n = config.challenges.length
  let order = 0
  for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
    for (let index = 0; index < n; index += 1) {
      const challenge = config.challenges[(index + repeat - 1) % n]
      if (!challenge) continue
      order += 1
      plan.push({
        sampleId: `${slug(config.group)}-r${repeat}-${String(order).padStart(3, "0")}-${slug(challenge.id)}`,
        challenge,
        repeat,
        order,
      })
    }
  }
  return plan
}

interface SampleContext {
  config: EvaluationConfig
  deps: EvaluationDeps
  signal: AbortSignal | undefined
  sampleId: string
  challenge: EvaluationConfig["challenges"][number]
  repeat: number
  order: number
}

interface SampleProgress {
  dispatchedAtMs: number | null
  deadlineMs: number | null
  stopReason: StopReason
  isolationFailed: boolean
  cancel: SampleResult["cancel"]
}

async function resetPlatform(context: SampleContext, sampleDirectory: string): Promise<void> {
  const { config, deps } = context
  if (!config.resetCommand) return
  const reset = await deps.runCommand(
    config.resetCommand,
    {
      EVAL_GROUP: config.group,
      EVAL_SAMPLE_ID: context.sampleId,
      EVAL_CHALLENGE_ID: context.challenge.id,
      EVAL_REPEAT: String(context.repeat),
    },
    config.backend.cwd,
  )
  await writeFile(join(sampleDirectory, "reset.log"), reset.output)
  if (reset.code !== 0) {
    throw new SampleStepError("reset", "reset_failed", `平台重置命令退出码 ${String(reset.code)}`)
  }
}

/** Wait for the platform connection (logging in if needed), then dispatch without force. */
async function dispatchWhenReady(
  context: SampleContext,
  api: BackendApi,
  backend: { exited: boolean },
  progress: SampleProgress,
): Promise<void> {
  const { config, deps, challenge } = context
  const readyDeadline = deps.now() + config.readyTimeoutMs
  let loggedIn = false
  let lastFailure: ApiResult | undefined
  for (;;) {
    if (context.signal?.aborted)
      throw new SampleStepError("ready", "aborted", "评测被中止", "aborted")
    if (backend.exited) {
      throw new SampleStepError("ready", "backend_exited", "后端在就绪前退出", "backend_exited")
    }
    if (deps.now() > readyDeadline) {
      if (lastFailure && !lastFailure.ok) {
        throw new SampleStepError("dispatch", lastFailure.code, lastFailure.message)
      }
      throw new SampleStepError("ready", "ready_timeout", "等待平台连接超时")
    }
    const health = await api.health()
    if (health?.controlPlanePhase === "ready") {
      if (health.authenticationEnabled && !health.authenticated && !loggedIn) {
        if (!config.webUiLogin) {
          throw new SampleStepError(
            "login",
            "login_required",
            "WebUI 启用了鉴权，但配置缺少 webUiLogin",
          )
        }
        const password = process.env[config.webUiLogin.passwordEnv]
        if (!password) {
          throw new SampleStepError(
            "login",
            "password_missing",
            `环境变量 ${config.webUiLogin.passwordEnv} 未设置`,
          )
        }
        const login = await api.login(config.webUiLogin.username, password)
        if (!login.ok) throw new SampleStepError("login", login.code, login.message)
        loggedIn = true
        continue
      }
      const dispatched = await api.dispatch(config.projectId, challenge.id)
      if (dispatched.ok) {
        progress.dispatchedAtMs = deps.now()
        progress.deadlineMs = progress.dispatchedAtMs + config.wallClockMs
        return
      }
      if (dispatched.code === "already_solved") {
        progress.isolationFailed = true
        throw new SampleStepError("dispatch", dispatched.code, dispatched.message)
      }
      if (dispatched.status !== 0 && dispatched.status !== 503) {
        throw new SampleStepError("dispatch", dispatched.code, dispatched.message)
      }
      lastFailure = dispatched
    }
    await deps.sleep(config.pollIntervalMs)
  }
}

/** Poll the sample's RunStore until accepted, finished, deadline, abort or exit. */
async function watchUntilStop(
  context: SampleContext,
  stateDirectory: string,
  backend: { exited: boolean },
  progress: SampleProgress,
): Promise<boolean> {
  const { config, deps, challenge } = context
  const deadlineMs = progress.deadlineMs ?? deps.now()
  let acceptedSeenAt: number | undefined
  let idleSince: number | undefined
  for (;;) {
    const now = deps.now()
    const state = await readRunState(stateDirectory, challenge.id)
    const busy = state.activeRunIds.length > 0 || state.queued !== null
    if (context.signal?.aborted) {
      progress.stopReason = "aborted"
      return busy
    }
    if (backend.exited) {
      progress.stopReason = "backend_exited"
      return false
    }
    if (state.firstAcceptedAt !== null) acceptedSeenAt ??= now
    idleSince = busy ? undefined : (idleSince ?? now)
    if (acceptedSeenAt !== undefined) {
      // Success is settled; keep observing writeup/cleanup for a bounded time.
      if (!busy || now - acceptedSeenAt >= config.postAcceptGraceMs) {
        progress.stopReason = "accepted"
        return busy
      }
    } else if (now >= deadlineMs) {
      progress.stopReason = "deadline"
      return busy
    } else if (
      state.runs.length > 0 &&
      idleSince !== undefined &&
      now - idleSince >= config.idleSettleMs
    ) {
      progress.stopReason = "finished"
      return false
    }
    await deps.sleep(config.pollIntervalMs)
  }
}

async function cancelAndDrain(
  context: SampleContext,
  api: BackendApi,
  stateDirectory: string,
  backend: { exited: boolean },
  progress: SampleProgress,
): Promise<void> {
  const { config, deps, challenge } = context
  const requestedAt = deps.now()
  progress.cancel = {
    requestedAt: iso(requestedAt),
    result: await api.cancel(config.projectId, challenge.id),
  }
  while (deps.now() - requestedAt < config.cancelGraceMs && !backend.exited) {
    const state = await readRunState(stateDirectory, challenge.id)
    if (state.activeRunIds.length === 0 && state.queued === null) return
    await deps.sleep(config.pollIntervalMs)
  }
}

function classify(
  progress: SampleProgress,
  observation: SampleObservation | null,
): { outcome: SampleOutcome; acceptedAtMs: number | null } {
  const acceptedAtMs = observation?.firstAcceptedAt ? Date.parse(observation.firstAcceptedAt) : null
  const alreadySolvedAtMs = observation?.firstAlreadySolvedAt
    ? Date.parse(observation.firstAlreadySolvedAt)
    : null
  // already_solved before any acceptance of our own means the platform state leaked in.
  const leaked =
    alreadySolvedAtMs !== null && (acceptedAtMs === null || alreadySolvedAtMs < acceptedAtMs)
  if (progress.isolationFailed || leaked) return { outcome: "isolation_failed", acceptedAtMs }
  if (acceptedAtMs !== null && progress.deadlineMs !== null) {
    return {
      outcome: acceptedAtMs <= progress.deadlineMs ? "accepted" : "accepted_late",
      acceptedAtMs,
    }
  }
  if (progress.dispatchedAtMs === null || progress.stopReason === "harness_error") {
    return { outcome: "harness_error", acceptedAtMs }
  }
  return { outcome: "not_accepted", acceptedAtMs }
}

async function runSample(context: SampleContext): Promise<SampleResult> {
  const { config, deps, challenge } = context
  const startedAtMs = deps.now()
  const sampleDirectory = join(config.outputDir, "samples", context.sampleId)
  const sampleRoot = join(sampleDirectory, "root")
  const harnessErrors: HarnessError[] = []
  const progress: SampleProgress = {
    dispatchedAtMs: null,
    deadlineMs: null,
    stopReason: "harness_error",
    isolationFailed: false,
    cancel: null,
  }
  const backend: { exited: boolean; exit: BackendExit | null } = { exited: false, exit: null }
  const leftoverContainers = { found: 0, removed: 0 }
  let handle: BackendHandle | undefined
  let stateDirectory: string | undefined

  try {
    await mkdir(sampleDirectory, { recursive: false })
    await resetPlatform(context, sampleDirectory)
    await cloneTemplateRoot(config.templateRoot, sampleRoot)
    stateDirectory = await projectStateDirectory(sampleRoot, config.projectId)
    handle = await deps.launcher.start({
      root: sampleRoot,
      logFile: join(sampleDirectory, "backend.log"),
    })
    void handle.exited.then((exit) => {
      backend.exited = true
      backend.exit = exit
    })
    const api = deps.connect(handle.baseUrl)
    await dispatchWhenReady(context, api, backend, progress)
    deps.log(`${context.sampleId}: dispatched ${challenge.id}`)
    const needsCancel = await watchUntilStop(context, stateDirectory, backend, progress)
    if (needsCancel && !backend.exited) {
      await cancelAndDrain(context, api, stateDirectory, backend, progress)
    }
  } catch (error) {
    if (error instanceof SampleStepError) {
      progress.stopReason = error.stopReason
      harnessErrors.push({ step: error.step, code: error.code, message: error.message })
    } else {
      progress.stopReason = "harness_error"
      harnessErrors.push({ step: "sample", code: "unexpected_error", message: messageOf(error) })
    }
  } finally {
    if (handle) {
      try {
        backend.exit = await handle.stop(BACKEND_STOP_GRACE_MS)
      } catch (error) {
        harnessErrors.push({ step: "stop", code: "stop_failed", message: messageOf(error) })
      }
    }
  }

  const stoppedAtMs = deps.now()
  let observation: SampleObservation | null = null
  if (stateDirectory) {
    try {
      observation = await collectSample(stateDirectory, challenge.id, config.pricing)
    } catch (error) {
      harnessErrors.push({ step: "collect", code: "collect_failed", message: messageOf(error) })
    }
  }

  const runIds = observation?.runs.map((run) => run.id) ?? []
  if (runIds.length > 0) {
    try {
      const containers = await deps.listRunContainers(runIds)
      leftoverContainers.found = containers.length
      if (containers.length > 0 && config.removeLeftoverContainers) {
        await deps.removeContainers(containers)
        leftoverContainers.removed = containers.length
      }
    } catch (error) {
      harnessErrors.push({
        step: "containers",
        code: "container_check_failed",
        message: messageOf(error),
      })
    }
  }

  const { outcome, acceptedAtMs } = classify(progress, observation)
  return {
    schemaVersion: 1,
    group: config.group,
    sampleId: context.sampleId,
    challengeId: challenge.id,
    ...(challenge.label ? { challengeLabel: challenge.label } : {}),
    repeat: context.repeat,
    order: context.order,
    outcome,
    stopReason: progress.stopReason,
    startedAt: iso(startedAtMs),
    dispatchedAt: progress.dispatchedAtMs === null ? null : iso(progress.dispatchedAtMs),
    deadlineAt: progress.deadlineMs === null ? null : iso(progress.deadlineMs),
    stoppedAt: iso(stoppedAtMs),
    timeToAcceptMs:
      acceptedAtMs !== null && progress.dispatchedAtMs !== null
        ? acceptedAtMs - progress.dispatchedAtMs
        : null,
    harnessErrors,
    cancel: progress.cancel,
    backendExit: backend.exit,
    leftoverContainers,
    sampleRoot,
    observation,
  }
}

/**
 * Run every sample of one group sequentially, appending one JSON line per
 * sample to results.jsonl as soon as it finishes. Failures are recorded, never
 * dropped.
 */
export async function runEvaluation(
  config: EvaluationConfig,
  deps: EvaluationDeps,
  signal?: AbortSignal,
): Promise<SampleResult[]> {
  const resultsPath = join(config.outputDir, "results.jsonl")
  if (await stat(resultsPath).catch(() => undefined)) {
    throw new Error(`输出目录已有结果，请换一个 outputDir：${resultsPath}`)
  }
  await mkdir(join(config.outputDir, "samples"), { recursive: true })
  const plan = sampleOrder(config)
  const manifest = {
    schemaVersion: 1,
    group: config.group,
    createdAt: iso(deps.now()),
    config,
    environment: await deps.environment(config),
    template: await templateFingerprint(config.templateRoot),
    plan: plan.map(({ sampleId, challenge, repeat, order }) => ({
      sampleId,
      challengeId: challenge.id,
      repeat,
      order,
    })),
  }
  await writeFile(join(config.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  const results: SampleResult[] = []
  for (const item of plan) {
    if (signal?.aborted) break
    deps.log(`${item.sampleId}: start (${item.order}/${plan.length})`)
    const result = await runSample({ config, deps, signal, ...item })
    results.push(result)
    await appendFile(resultsPath, `${JSON.stringify(result)}\n`)
    deps.log(`${item.sampleId}: ${result.outcome} (${result.stopReason})`)
  }
  return results
}

async function gitIdentity(cwd: string): Promise<EnvironmentIdentity["backendGit"]> {
  try {
    const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim()
    const status = (await execFileAsync("git", ["status", "--porcelain"], { cwd })).stdout
    return { commit, dirty: status.trim().length > 0 }
  } catch {
    return { commit: null, dirty: null }
  }
}

function runCommand(
  command: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const [file, ...args] = command
    if (!file) {
      resolve({ code: null, output: "empty command" })
      return
    }
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let output = ""
    const keep = (chunk: Buffer) => {
      if (output.length < MAX_COMMAND_OUTPUT) output += chunk.toString("utf8")
    }
    child.stdout.on("data", keep)
    child.stderr.on("data", keep)
    child.once("error", (error) => resolve({ code: null, output: `${output}${error.message}` }))
    child.once("close", (code) => resolve({ code, output: output.slice(0, MAX_COMMAND_OUTPUT) }))
  })
}

/** Production dependencies: real processes, Docker CLI and wall-clock time. */
export function defaultEvaluationDeps(config: EvaluationConfig): EvaluationDeps {
  return {
    launcher: processBackendLauncher(config.backend),
    connect: httpBackendApi,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    runCommand,
    async listRunContainers(runIds) {
      const ids = new Set<string>()
      for (const runId of runIds) {
        const { stdout } = await execFileAsync("docker", [
          "ps",
          "-aq",
          "--filter",
          `label=ctf-agent.run=${runId}`,
        ])
        for (const id of stdout.split(/\s+/)) if (id) ids.add(id)
      }
      return [...ids]
    },
    async removeContainers(ids) {
      await execFileAsync("docker", ["rm", "-f", ...ids])
    },
    async environment(current) {
      let solverImageId: string | null = null
      try {
        solverImageId = (
          await execFileAsync("docker", [
            "image",
            "inspect",
            "ctf-agent-solver:latest",
            "--format",
            "{{.Id}}",
          ])
        ).stdout.trim()
      } catch {
        solverImageId = null
      }
      return {
        evaluatorNode: process.version,
        platform: `${process.platform}/${process.arch}`,
        backendGit: await gitIdentity(current.backend.cwd),
        solverImageId,
      }
    },
    log: (message) => console.log(`[eval ${new Date().toISOString()}] ${message}`),
  }
}
