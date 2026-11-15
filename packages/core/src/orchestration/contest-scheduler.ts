import type { CtfSolverAgent } from "@ctf-agent/agents"
import type { ChallengeSummary } from "@ctf-agent/platform"
import { INCOMPLETE_CONTINUATION_PROMPT, WRITEUP_PROMPT } from "@ctf-agent/prompts"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type {
  RunRecord,
  RunSource,
  SchedulerMode,
  SchedulerQueueRecord,
  SchedulerQueueStage,
} from "../persistence/run-store.ts"
import type { CreateSolverOptions, Project } from "../project/project.ts"
import { hasTerminalSubmission, runSolverPrompt } from "./solver-attempt.ts"
import { classifySolverStop } from "./stop-classifier.ts"
import { validateChallengeWriteup } from "./writeup-validator.ts"

export type SchedulerQueueSource = Extract<RunSource, "auto" | "manual" | "retry" | "revival">
export type SchedulerPhase = "preparing" | "running" | "waiting_environment" | "cancelling"
export type SchedulerRuntimeState = "stopped" | "running" | "automatic" | "suspended"

export interface ContestSchedulerOptions {
  maxConcurrent: number
  abortGraceMs?: number
  retryDelayMs?: number
  infrastructureRetryDelayMs?: number
  transientRetryDelaysMs?: readonly [number, number, number]
  /** Flag accepted 后执行 writeup turn；生产调度应开启。 */
  writeup?: boolean
  createAgentOptions(context: SchedulerAttemptContext): AgentOptions | Promise<AgentOptions>
  compaction?: CreateSolverOptions["compaction"]
  prompt?: string | ((context: SchedulerAttemptContext) => string | Promise<string>)
  availability?: () => SchedulerAvailability
  available?: boolean
  unavailableReason?: string
  /** Persist the new runtime concurrency limit before it becomes active. */
  onMaxConcurrentChange?: (maxConcurrent: number) => void | Promise<void>
}

export interface SchedulerAvailability {
  available: boolean
  unavailableReason?: string
}

export interface SchedulerAttemptContext {
  challenge: ChallengeSummary
  attempt: number
  source: SchedulerQueueSource
}

export interface SchedulerQueueEntry {
  challengeId: string
  source: SchedulerQueueSource
  stage: SchedulerQueueStage
  lane: "normal" | "blocked"
  manualOverride: boolean
  enqueuedAt: string
  position: number
  version: number
}

export interface SchedulerActiveEntry {
  challengeId: string
  runId: string | null
  attempt: number
  source: SchedulerQueueSource
  phase: SchedulerPhase
  startedAt: string
}

export interface ContestSchedulerSnapshot {
  available: boolean
  unavailableReason?: string
  /** 兼容旧客户端；manual/automatic 均为 true。 */
  autoEnabled: boolean
  state: SchedulerRuntimeState
  mode: SchedulerMode
  idleVersion: number
  executionVersion: number
  maxConcurrent: number
  idle: SchedulerQueueEntry[]
  queued: SchedulerQueueEntry[]
  active: SchedulerActiveEntry[]
  lastError?: string
  goals: import("../persistence/solve-goals.ts").SolveGoal[]
}

export class ContestSchedulerError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "challenge_not_found"
      | "run_not_found"
      | "run_not_retryable"
      | "already_queued"
      | "already_active"
      | "already_solved"
      | "blocked"
      | "excluded"
      | "auto_enabled"
      | "scheduler_running"
      | "queue_version_conflict",
    message: string,
  ) {
    super(message)
    this.name = "ContestSchedulerError"
  }
}

interface QueueItem {
  challenge: ChallengeSummary
  source: SchedulerQueueSource
  stage: SchedulerQueueStage
  lane: "normal" | "blocked"
  manualOverride: boolean
  requiresAuto: boolean
  enqueuedAt: string
  version: number
  resumeRun?: RunRecord
  retryPrompt?: string
  writeupRetry?: boolean
}

interface ActiveItem {
  challenge: ChallengeSummary
  source: SchedulerQueueSource
  lane: "normal" | "blocked"
  requiresAuto: boolean
  attempt: number
  phase: SchedulerPhase
  startedAt: string
  runId: string | null
  solver?: CtfSolverAgent
  cancelRequested: boolean
  operation?: Promise<void>
  resumeRun?: RunRecord
  retryPrompt?: string
  writeupRetry?: boolean
  cancelRetryDelay?: () => void
  controller: AbortController
  postprocessing?: boolean
}

export const DEFAULT_TRANSIENT_RETRY_DELAYS_MS = [10_000, 60_000, 300_000] as const

const RECOVERABLE_SCHEDULER_RUN_SOURCES = new Set<RunSource>(["auto", "manual", "retry", "revival"])
const RECOVERABLE_TERMINAL_RUN_STATUSES = new Set<RunRecord["status"]>([
  "failed",
  "timed_out",
  "cancelled",
  "closed",
  "interrupted",
  "blocked",
])

/**
 * 长驻的混合调度控制面：
 * - manual 模式只执行用户从空闲队列提交的题目；automatic 模式持续补充全部可调度题；
 * - 暂停保留空闲/执行队列且不取消已经运行的任务；
 * - 同题在 idle/execution/active 阶段互斥；
 * - 求解意图跨 Run/重启保存，只有判题确认或人工停止才结束目标。
 */
export class ContestScheduler {
  private readonly idleQueue: QueueItem[] = []
  private readonly queue: QueueItem[] = []
  private readonly active = new Map<string, ActiveItem>()
  private mode: SchedulerMode
  private shuttingDown = false
  private shutdownOperation?: Promise<void>
  private pumping = false
  private lastError?: string
  private maxConcurrent: number
  private wakeTimer?: NodeJS.Timeout
  private suspensionReason?: string
  private discoveringAdmission = false
  /** 正在被 resetChallenge 清空的题目：任何在途 reconcile/pump 都必须跳过，避免 wipe 期间重建 Run。 */
  private readonly resetting = new Set<string>()
  private readonly stopVersions = new Map<string, number>()
  private readonly admissionDiscoveryRetryAt = new Map<string, number>()
  private readonly unsubscribeRemoteEnvironmentCapacity: () => void

  constructor(
    private readonly project: Project,
    private readonly options: ContestSchedulerOptions,
  ) {
    positiveInteger(options.maxConcurrent, "maxConcurrent")
    this.mode = project.schedulerState().mode
    this.maxConcurrent = options.maxConcurrent
    nonNegativeInteger(options.abortGraceMs ?? 5_000, "abortGraceMs")
    nonNegativeInteger(options.retryDelayMs ?? 2_000, "retryDelayMs")
    nonNegativeInteger(options.infrastructureRetryDelayMs ?? 15_000, "infrastructureRetryDelayMs")
    this.unsubscribeRemoteEnvironmentCapacity = this.project.subscribeRemoteEnvironmentCapacity(
      () => this.pump(),
    )
    for (const [index, delay] of (
      options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS
    ).entries()) {
      nonNegativeInteger(delay, `transientRetryDelaysMs[${index}]`)
    }
  }

  snapshot(): ContestSchedulerSnapshot {
    this.syncPersistedQueueMetadata()
    const availability = this.availability()
    const state = this.project.schedulerState()
    const entry = (item: QueueItem, index: number): SchedulerQueueEntry => ({
      challengeId: item.challenge.id,
      source: item.source,
      stage: item.stage,
      lane: item.lane,
      manualOverride: item.manualOverride,
      enqueuedAt: item.enqueuedAt,
      position: index + 1,
      version: item.version,
    })
    const persistedEntry = (item: SchedulerQueueRecord, index: number): SchedulerQueueEntry => ({
      challengeId: item.challengeId,
      source: item.source as SchedulerQueueSource,
      stage: item.stage,
      lane: item.lane,
      manualOverride: item.manualOverride,
      enqueuedAt: item.enqueuedAt,
      position: index + 1,
      version: item.version,
    })
    // restore() 可能因模型或平台暂不可用而无法取得 ChallengeSummary；此时快照仍必须
    // 暴露 RunStore 中的编排意图，避免 Dashboard 把持久队列误报为空。
    const usePersistedFallback =
      this.idleQueue.length === 0 && this.queue.length === 0 && this.active.size === 0
    const idle = usePersistedFallback
      ? this.project.schedulerQueue("idle").map(persistedEntry)
      : this.idleQueue.map(entry)
    const queued = usePersistedFallback
      ? this.project.schedulerQueue("execution").map(persistedEntry)
      : this.queue.map(entry)
    const paused = this.project.solveGoals.list().find((goal) => goal.state === "paused")
    const runtimeState: SchedulerRuntimeState =
      this.suspensionReason || paused
        ? "suspended"
        : this.mode === "automatic"
          ? "automatic"
          : this.mode === "manual"
            ? "running"
            : "stopped"
    return {
      available: availability.available,
      ...(availability.unavailableReason
        ? { unavailableReason: availability.unavailableReason }
        : {}),
      autoEnabled: this.mode !== "stopped",
      state: runtimeState,
      mode: this.mode,
      idleVersion: state.idleVersion,
      executionVersion: state.executionVersion,
      maxConcurrent: this.maxConcurrent,
      idle,
      queued,
      active: [...this.active.values()].map((item) => ({
        challengeId: item.challenge.id,
        runId: item.runId,
        attempt: item.attempt,
        source: item.source,
        phase: item.phase,
        startedAt: item.startedAt,
      })),
      ...((this.lastError ?? paused?.reason)
        ? { lastError: this.lastError ?? paused!.reason! }
        : {}),
      goals: this.project.solveGoals.list(),
    }
  }

  /** 恢复持久化调度意图与两阶段队列；生产创建 Scheduler 后调用一次。 */
  async restore(): Promise<ContestSchedulerSnapshot> {
    return this.reconcile()
  }

  /** 用户启动：只提交已经排好顺序的空闲队列，不隐式加入其他赛题。 */
  async start(): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    this.mode = this.project.startScheduler("manual").mode
    this.promoteIdleInMemory()
    await this.reconcile()
    this.pump()
    return this.snapshot()
  }

  /** 自动模式保留给 CLI/显式自动化：持续补充所有可调度题目。 */
  async startAuto(): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.mode = this.project.startScheduler("automatic").mode
    this.promoteIdleInMemory()
    await this.reconcile()
    this.pump()
    return this.snapshot()
  }

  pauseAuto(): ContestSchedulerSnapshot {
    this.mode = this.project.setSchedulerMode("stopped").mode
    // 已运行任务可以自然结束，但等待任务及其后续 retry 必须冻结到再次启动。
    for (const item of this.queue) item.requiresAuto = true
    for (const item of this.active.values()) item.requiresAuto = true
    return this.snapshot()
  }

  /** 平台暂不可用时冻结领取，不清除持久队列或调度意图。 */
  suspend(reason: string): ContestSchedulerSnapshot {
    this.suspensionReason = reason
    return this.snapshot()
  }

  /** 平台恢复后继续处理挂起前保留的队列。 */
  resume(options: { configuration?: boolean } = {}): ContestSchedulerSnapshot {
    this.suspensionReason = undefined
    if (options.configuration !== false) {
      for (const goal of this.project.solveGoals.list()) {
        if (goal.state === "paused")
          this.project.solveGoals.update(goal.id, {
            state: "active",
            failures: 0,
            reason: null,
            retryAt: null,
          })
      }
      this.lastError = undefined
    }
    this.pump()
    return this.snapshot()
  }

  async setMaxConcurrent(maxConcurrent: number): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    positiveInteger(maxConcurrent, "maxConcurrent")
    if (maxConcurrent > 64) throw new Error("maxConcurrent 不能超过 64")
    if (maxConcurrent === this.maxConcurrent) return this.snapshot()
    await this.options.onMaxConcurrentChange?.(maxConcurrent)
    this.maxConcurrent = maxConcurrent
    this.pump()
    return this.snapshot()
  }

  async reconcile(): Promise<ContestSchedulerSnapshot> {
    if (this.shuttingDown || !this.availability().available) return this.snapshot()
    await this.project.refresh()
    const challenges = deduplicate(await this.project.challenges())
    if (this.shuttingDown || !this.availability().available) return this.snapshot()
    const byId = new Map(challenges.map((challenge) => [challenge.id, challenge]))
    const invalid = (challengeId: string): boolean => {
      const challenge = byId.get(challengeId)
      return (
        !challenge ||
        challenge.solved ||
        this.project.isChallengeSolved(challengeId) ||
        this.project.isChallengeSchedulingExcluded(challengeId)
      )
    }
    const recoverableRuns = latestRecoverableInterruptedRuns(this.project.runs())

    for (const items of [this.idleQueue, this.queue]) {
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index]
        if (!item || item.writeupRetry || !invalid(item.challenge.id)) continue
        items.splice(index, 1)
        this.project.removeSchedulerChallenge(item.challenge.id)
      }
    }

    for (const persisted of this.project.schedulerQueue()) {
      if (this.resetting.has(persisted.challengeId)) continue
      const challenge = byId.get(persisted.challengeId)
      if (!challenge || (!persisted.writeupRetry && invalid(persisted.challengeId))) {
        this.project.removeSchedulerChallenge(persisted.challengeId)
        continue
      }
      if (this.hasChallenge(persisted.challengeId)) continue
      if (this.project.solveGoals.get(persisted.challengeId)?.state === "stopped") {
        this.project.removeSchedulerChallenge(persisted.challengeId)
        continue
      }
      const resumeRun = persisted.resumeRunId
        ? this.project
            .runs({ challengeId: persisted.challengeId })
            .find((run) => run.id === persisted.resumeRunId)
        : (this.project
            .runs({ challengeId: persisted.challengeId })
            .find((run) => run.id === this.project.solveGoals.get(persisted.challengeId)?.runId) ??
          recoverableRuns.get(persisted.challengeId))
      if (resumeRun) recoverableRuns.delete(persisted.challengeId)
      const item: QueueItem = {
        challenge,
        source: persisted.source as SchedulerQueueSource,
        stage: persisted.stage,
        lane: persisted.lane,
        manualOverride: persisted.manualOverride,
        requiresAuto: persisted.requiresAuto,
        enqueuedAt: persisted.enqueuedAt,
        version: persisted.version,
        ...(resumeRun ? { resumeRun } : {}),
        ...(persisted.retryPrompt ? { retryPrompt: persisted.retryPrompt } : {}),
        ...(persisted.writeupRetry ? { writeupRetry: true } : {}),
      }
      if (persisted.stage === "idle") this.idleQueue.push(item)
      else this.queue.push(item)
    }

    for (const goal of this.project.solveGoals.list()) {
      const challenge = byId.get(goal.challengeId)
      if (!challenge || this.resetting.has(goal.challengeId)) continue
      if (invalid(goal.challengeId)) {
        if (challenge.solved || this.project.isChallengeSolved(goal.challengeId)) {
          this.project.solveGoals.update(goal.id, {
            state: "accepted",
            retryAt: null,
            reason: null,
          })
          const active = this.active.get(goal.challengeId)
          if (
            active &&
            !active.postprocessing &&
            !(active.solver && hasTerminalSubmission(active.solver)) &&
            !this.hasRecordedSolveOutcome(goal.challengeId, active.runId ?? "")
          ) {
            active.controller.abort()
            active.cancelRetryDelay?.()
          }
        }
        continue
      }
      if (
        (goal.state !== "active" && goal.state !== "paused") ||
        this.hasChallenge(goal.challengeId)
      )
        continue
      const runs = this.project.runs({ challengeId: goal.challengeId })
      const resumeRun = goal.runId
        ? runs.find((run) => run.id === goal.runId)
        : latestRecoverableRun(runs)
      this.enqueueChallenge(
        challenge,
        "retry",
        "execution",
        "normal",
        false,
        goal.requiresAuto,
        resumeRun ? { resumeRun } : {},
      )
    }

    if (this.mode !== "stopped") {
      for (const resumeRun of recoverableRuns.values()) {
        const challenge = byId.get(resumeRun.challengeId)
        if (
          !challenge ||
          invalid(challenge.id) ||
          this.project.solveGoals.get(challenge.id)?.state === "stopped" ||
          this.project.isChallengeBlocked(challenge.id) ||
          this.hasChallenge(challenge.id)
        ) {
          continue
        }
        this.enqueueChallenge(challenge, "retry", "execution", "normal", true, true, { resumeRun })
      }
    }

    if (this.mode === "automatic") {
      for (const challenge of challenges) {
        if (
          this.resetting.has(challenge.id) ||
          this.project.solveGoals.get(challenge.id)?.state === "stopped" ||
          challenge.solved ||
          this.project.isChallengeSolved(challenge.id) ||
          this.project.isChallengeSchedulingExcluded(challenge.id) ||
          this.project.isChallengeBlocked(challenge.id) ||
          this.hasChallenge(challenge.id)
        ) {
          continue
        }
        this.enqueueChallenge(challenge, "auto", "execution", "normal", false, true)
      }

      const ordinaryOutstanding = challenges.some(
        (challenge) =>
          !this.resetting.has(challenge.id) &&
          this.project.solveGoals.get(challenge.id)?.state !== "stopped" &&
          !challenge.solved &&
          !this.project.isChallengeSolved(challenge.id) &&
          !this.project.isChallengeSchedulingExcluded(challenge.id) &&
          !this.project.isChallengeBlocked(challenge.id),
      )
      if (!ordinaryOutstanding) {
        const blocked = challenges
          .filter(
            (challenge) =>
              !this.resetting.has(challenge.id) &&
              this.project.solveGoals.get(challenge.id)?.state !== "stopped" &&
              !challenge.solved &&
              !this.project.isChallengeSchedulingExcluded(challenge.id) &&
              this.project.isChallengeBlocked(challenge.id) &&
              !this.hasChallenge(challenge.id),
          )
          .sort((left, right) => {
            const leftAt = this.project.challengeRuntimeState(left.id).blockedAt ?? ""
            const rightAt = this.project.challengeRuntimeState(right.id).blockedAt ?? ""
            return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id)
          })
        for (const challenge of blocked) {
          this.enqueueChallenge(challenge, "revival", "execution", "blocked", false, true)
        }
      }
    }
    this.pump()
    return this.snapshot()
  }

  async stage(challengeIds: readonly string[]): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    const uniqueIds = [...new Set(challengeIds)]
    const versions = new Map(uniqueIds.map((id) => [id, this.stopVersions.get(id)]))
    if (uniqueIds.length === 0) return this.snapshot()
    await this.reconcile()
    const challenges = new Map((await this.project.challenges()).map((item) => [item.id, item]))
    // refresh/challenges 都会让出事件循环；提交批量写入前必须重新校验，避免并发 start()
    // 已迁移旧计划后又插入新的 idle 项。
    this.assertAvailable()
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    const additions: Array<{ challenge: ChallengeSummary; record: SchedulerQueueRecord }> = []
    const inputs: Array<{
      challengeId: string
      source: "manual"
      stage: "idle"
      lane: "normal"
      manualOverride: false
    }> = []

    for (const challengeId of uniqueIds) {
      if (this.stopVersions.get(challengeId) !== versions.get(challengeId))
        throw new ContestSchedulerError("unavailable", "编排期间该题已被停止")
      if (this.active.has(challengeId)) {
        throw new ContestSchedulerError("already_active", `${challengeId} 已有正在运行的 Agent`)
      }
      const existing = [...this.idleQueue, ...this.queue].find(
        (item) => item.challenge.id === challengeId,
      )
      if (existing?.stage === "idle") continue
      if (existing) {
        throw new ContestSchedulerError("already_queued", `${challengeId} 已在执行队列中`)
      }
      const challenge = challenges.get(challengeId)
      if (!challenge) {
        throw new ContestSchedulerError("challenge_not_found", `平台不存在题目: ${challengeId}`)
      }
      const disposition = this.project.challengeSchedulingDisposition(challengeId)
      if (disposition) {
        throw new ContestSchedulerError(
          "excluded",
          disposition === "solved"
            ? `${challenge.title} 已人工标记为已解出`
            : `${challenge.title} 已标记为不调度`,
        )
      }
      if (challenge.solved || this.project.isChallengeSolved(challengeId)) {
        throw new ContestSchedulerError("already_solved", `${challenge.title} 已经解出`)
      }
      if (this.project.isChallengeBlocked(challengeId)) {
        throw new ContestSchedulerError("blocked", `${challenge.title} 已 blocked，不能批量加入`)
      }
      inputs.push({
        challengeId,
        source: "manual",
        stage: "idle",
        lane: "normal",
        manualOverride: false,
      })
    }

    const records = this.project.enqueueSchedulerChallenges(inputs)
    for (const record of records) {
      const challenge = challenges.get(record.challengeId)
      if (challenge) additions.push({ challenge, record })
    }
    for (const { challenge, record } of additions) {
      this.project.solveGoals.begin(challenge.id, true)
      if (this.hasChallenge(challenge.id)) continue
      this.idleQueue.push({
        challenge,
        source: "manual",
        stage: "idle",
        lane: "normal",
        manualOverride: false,
        requiresAuto: true,
        enqueuedAt: record.enqueuedAt,
        version: record.version,
      })
    }
    return this.snapshot()
  }

  unstage(challengeIds: readonly string[]): ContestSchedulerSnapshot {
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    const ids = new Set(challengeIds)
    this.project.removeSchedulerChallenges([...ids], "idle")
    for (let index = this.idleQueue.length - 1; index >= 0; index--) {
      const item = this.idleQueue[index]
      if (item && ids.has(item.challenge.id)) {
        this.stopVersions.set(
          item.challenge.id,
          (this.stopVersions.get(item.challenge.id) ?? 0) + 1,
        )
        const goal = this.project.solveGoals.get(item.challenge.id)
        if (goal)
          this.project.solveGoals.update(goal.id, {
            state: "stopped",
            reason: "已移出空闲队列",
            retryAt: null,
          })
        this.idleQueue.splice(index, 1)
      }
    }
    return this.snapshot()
  }

  reorderIdle(challengeIds: readonly string[], expectedVersion: number): ContestSchedulerSnapshot {
    this.assertNotShuttingDown()
    this.assertPlanningStopped()
    let records: SchedulerQueueRecord[]
    try {
      records = this.project.reorderSchedulerStage("idle", challengeIds, expectedVersion)
    } catch (error) {
      if (errorText(error).includes("version conflict")) {
        throw new ContestSchedulerError("queue_version_conflict", errorText(error))
      }
      throw error
    }
    const byId = new Map(this.idleQueue.map((item) => [item.challenge.id, item]))
    this.idleQueue.length = 0
    for (const record of records) {
      const item = byId.get(record.challengeId)
      if (!item) continue
      item.version = record.version
      item.enqueuedAt = record.enqueuedAt
      this.idleQueue.push(item)
    }
    return this.snapshot()
  }

  async dispatch(
    challengeId: string,
    options: { force?: boolean } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    const stopVersion = this.stopVersions.get(challengeId)
    if (this.active.has(challengeId)) {
      throw new ContestSchedulerError("already_active", "该题已有正在运行的 Agent")
    }
    if (
      this.queue.some((item) => item.challenge.id === challengeId) ||
      this.idleQueue.some((item) => item.challenge.id === challengeId)
    ) {
      throw new ContestSchedulerError("already_queued", "该题已经在调度队列中")
    }
    await this.project.refresh()
    const challenge = (await this.project.challenges()).find(
      (candidate) => candidate.id === challengeId,
    )
    this.assertAdmissionCurrent(challengeId, stopVersion)
    if (!challenge) {
      throw new ContestSchedulerError("challenge_not_found", `平台不存在题目: ${challengeId}`)
    }
    const schedulingDisposition = this.project.challengeSchedulingDisposition(challengeId)
    if (schedulingDisposition) {
      throw new ContestSchedulerError(
        "excluded",
        schedulingDisposition === "solved"
          ? "该题已人工标记为已解出；请先恢复默认调度状态"
          : "该题已标记为不调度；请先恢复默认调度状态",
      )
    }
    const solved = challenge.solved || this.project.isChallengeSolved(challengeId)
    if (solved && !options.force) {
      throw new ContestSchedulerError("already_solved", "该题已经解出；重新验证需要显式 force")
    }
    const blocked = this.project.isChallengeBlocked(challengeId)
    if (blocked && !options.force) {
      throw new ContestSchedulerError(
        "blocked",
        "该题已 blocked；需要人工 force 将其提前到调度队列",
      )
    }
    const resumeRun = blocked ? undefined : latestRecoverableRun(this.project.runs({ challengeId }))
    this.project.solveGoals.begin(challenge.id, false)
    this.enqueueChallenge(
      challenge,
      blocked ? "revival" : "manual",
      "execution",
      blocked ? "blocked" : "normal",
      blocked,
      false,
      resumeRun ? { resumeRun } : undefined,
    )
    this.pump()
    return this.snapshot()
  }

  async retryAttempt(
    runId: string,
    options: { prompt?: string } = {},
  ): Promise<ContestSchedulerSnapshot> {
    this.assertAvailable()
    this.assertNotShuttingDown()
    const run = this.project.runs().find((candidate) => candidate.id === runId)
    if (!run) {
      throw new ContestSchedulerError("run_not_found", `Run 不存在: ${runId}`)
    }
    if (!RETRYABLE_RUN_STATUSES.has(run.status)) {
      throw new ContestSchedulerError(
        "run_not_retryable",
        `Run ${runId} 当前状态 ${run.status} 不允许重试`,
      )
    }
    if (this.active.has(run.challengeId)) {
      throw new ContestSchedulerError("already_active", "该题已有正在运行的 Agent")
    }
    if (
      this.queue.some((item) => item.challenge.id === run.challengeId) ||
      this.idleQueue.some((item) => item.challenge.id === run.challengeId)
    ) {
      throw new ContestSchedulerError("already_queued", "该题已经在调度队列中")
    }
    const prompt = options.prompt?.trim()
    if (prompt && prompt.length > 32_000) {
      throw new Error("重试提示词长度不能超过 32000")
    }
    const stopVersion = this.stopVersions.get(run.challengeId)
    await this.project.refresh()
    const challenge = (await this.project.challenges()).find(
      (candidate) => candidate.id === run.challengeId,
    )
    this.assertAdmissionCurrent(run.challengeId, stopVersion)
    if (!challenge) {
      throw new ContestSchedulerError("challenge_not_found", `平台不存在题目: ${run.challengeId}`)
    }
    if (this.project.challengeSchedulingDisposition(run.challengeId)) {
      throw new ContestSchedulerError("excluded", "该题已设置人工调度状态；请先恢复默认调度状态")
    }
    const writeupRetry =
      this.options.writeup === true &&
      this.project
        .runEvents(run.id)
        .some((event) => event.type === "run_writing_writeup" || event.type === "writeup_failed")
    if (!writeupRetry && (challenge.solved || this.project.isChallengeSolved(run.challengeId))) {
      throw new ContestSchedulerError("already_solved", "该题已经解出")
    }
    const blocked = this.project.isChallengeBlocked(run.challengeId)
    if (!writeupRetry || !this.project.solveGoals.get(challenge.id))
      this.project.solveGoals.begin(challenge.id, false)
    this.enqueueChallenge(
      challenge,
      "retry",
      "execution",
      blocked ? "blocked" : "normal",
      true,
      false,
      {
        resumeRun: run,
        ...(prompt ? { retryPrompt: prompt } : {}),
        ...(writeupRetry ? { writeupRetry: true } : {}),
      },
    )
    this.pump()
    return this.snapshot()
  }

  reorderQueue(
    challengeId: string,
    options: {
      position: number
      expectedVersion: number
      overrideBlockedLane?: boolean
    },
  ): ContestSchedulerSnapshot {
    const item = this.queue.find((candidate) => candidate.challenge.id === challengeId)
    if (!item) {
      throw new ContestSchedulerError("challenge_not_found", `题目不在调度队列中: ${challengeId}`)
    }
    let moved: SchedulerQueueRecord
    try {
      moved = this.project.moveSchedulerChallenge({
        challengeId,
        position: options.position,
        expectedVersion: options.expectedVersion,
        overrideBlockedLane: options.overrideBlockedLane,
      })
    } catch (error) {
      if (errorText(error).includes("version conflict")) {
        throw new ContestSchedulerError("queue_version_conflict", errorText(error))
      }
      throw error
    }
    item.manualOverride = moved.manualOverride
    item.version = moved.version
    item.requiresAuto = moved.requiresAuto
    const persisted = this.project.schedulerQueue("execution")
    this.syncPersistedQueueMetadata(persisted)
    const order = new Map(persisted.map((record, index) => [record.challengeId, index]))
    this.queue.sort(
      (left, right) =>
        (order.get(left.challenge.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.challenge.id) ?? Number.MAX_SAFE_INTEGER),
    )
    this.pump()
    return this.snapshot()
  }

  /**
   * RunStore 在删除或重排条目时也会更新所有位置受影响行的版本。
   * 内存队列必须在发布 snapshot 前回灌这些版本，否则 WebUI 会用陈旧版本
   * 发起下一次正常拖动，并被持久层误判为并发冲突。
   */
  private syncPersistedQueueMetadata(
    records: SchedulerQueueRecord[] = this.project.schedulerQueue(),
  ): void {
    const byId = new Map(records.map((record) => [record.challengeId, record]))
    for (const item of [...this.idleQueue, ...this.queue]) {
      const record = byId.get(item.challenge.id)
      if (!record) continue
      item.stage = record.stage
      item.lane = record.lane
      item.manualOverride = record.manualOverride
      item.enqueuedAt = record.enqueuedAt
      item.version = record.version
      item.requiresAuto = record.requiresAuto
    }
  }

  async cancel(challengeId: string): Promise<ContestSchedulerSnapshot> {
    this.stopVersions.set(challengeId, (this.stopVersions.get(challengeId) ?? 0) + 1)
    const goal =
      this.project.solveGoals.get(challengeId) ?? this.project.solveGoals.begin(challengeId, false)
    this.project.solveGoals.update(goal.id, {
      state: "stopped",
      reason: "由控制面停止",
      retryAt: null,
    })
    this.project.removeSchedulerChallenge(challengeId)
    const idleIndex = this.idleQueue.findIndex((item) => item.challenge.id === challengeId)
    if (idleIndex >= 0) {
      this.idleQueue.splice(idleIndex, 1)
      this.project.removeSchedulerChallenge(challengeId)
      return this.snapshot()
    }
    const queueIndex = this.queue.findIndex((item) => item.challenge.id === challengeId)
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1)
      return this.snapshot()
    }
    const active = this.active.get(challengeId)
    if (!active) return this.snapshot()
    active.cancelRequested = true
    active.controller.abort()
    active.phase = "cancelling"
    active.cancelRetryDelay?.()
    const failures: unknown[] = []
    try {
      await active.solver?.abort()
    } catch (error) {
      failures.push(error)
    }
    try {
      if (active.solver) await active.solver.close("cancelled", "由控制面取消")
    } catch (error) {
      failures.push(error)
    }
    await active.operation?.catch((error: unknown) => failures.push(error))
    if (failures.length > 0) {
      throw new AggregateError(failures, `Solver ${challengeId} 资源回收不完整`)
    }
    return this.snapshot()
  }

  /** 调度暂停后，正常停止当前所有 Solver，并等待其 SubAgent、远程环境与 Sandbox 回收。 */
  async stopAllActive(): Promise<ContestSchedulerSnapshot> {
    this.assertNotShuttingDown()
    if (this.mode !== "stopped") {
      throw new ContestSchedulerError("auto_enabled", "请先暂停调度，再停止所有 Solver")
    }
    const challengeIds = [...this.active.keys()]
    const settled = await Promise.allSettled(
      challengeIds.map(async (challengeId) => await this.cancel(challengeId)),
    )
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, "部分 Solver 资源回收失败")
    }
    return this.snapshot()
  }

  /** 完全重置单题：终止活跃/排队 Run，清空本地状态，自动模式开启则按新题重新入队。 */
  async resetChallenge(challengeId: string): Promise<ContestSchedulerSnapshot> {
    this.stopVersions.set(challengeId, (this.stopVersions.get(challengeId) ?? 0) + 1)
    this.resetting.add(challengeId)
    try {
      // (a) 摘除内存队列项 + 持久化 scheduler_queue 行（含 resumeRun：其指向的 Run 即将被删）
      const idleIndex = this.idleQueue.findIndex((item) => item.challenge.id === challengeId)
      if (idleIndex >= 0) this.idleQueue.splice(idleIndex, 1)
      const queueIndex = this.queue.findIndex((item) => item.challenge.id === challengeId)
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1)
      this.project.removeSchedulerChallenge(challengeId)

      // (b) 终止活跃 Run（abort + close "cancelled" → 回收 sandbox + 释放远程环境租约）
      const active = this.active.get(challengeId)
      if (active) {
        active.cancelRequested = true
        active.controller.abort()
        active.phase = "cancelling"
        active.cancelRetryDelay?.()
        await active.solver?.abort()
        if (active.solver) await active.solver.close("cancelled", "重置题目：运行已停止")
        await active.operation?.catch(() => undefined)
      }

      // (c) wipe DB + 磁盘 + 内存状态
      await this.project.resetChallenge(challengeId)
    } finally {
      this.resetting.delete(challengeId)
    }

    // (d) 自动重新入队（reconcile 自判 autoEnabled/availability；晚到的在途 reconcile 经
    //     hasChallenge/去重不会重复入队）
    if (this.mode !== "stopped") await this.reconcile()
    return this.snapshot()
  }

  async shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation
    this.shutdownOperation = this.performShutdown()
    return this.shutdownOperation
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true
    clearTimeout(this.wakeTimer)
    this.unsubscribeRemoteEnvironmentCapacity()
    this.mode = "stopped"
    this.idleQueue.length = 0
    this.queue.length = 0
    const active = [...this.active.values()]
    for (const item of active) {
      item.cancelRequested = true
      item.controller.abort()
      item.phase = "cancelling"
      item.cancelRetryDelay?.()
    }
    const settled = await Promise.allSettled(
      active.map(async (item) => {
        const failures: unknown[] = []
        try {
          await item.solver?.abort()
        } catch (error) {
          failures.push(error)
        }
        try {
          if (item.solver) await item.solver.close("cancelled", "调度控制面关闭")
        } catch (error) {
          failures.push(error)
        }
        await item.operation?.catch((error: unknown) => failures.push(error))
        if (failures.length > 0) {
          throw new AggregateError(failures, `Solver ${item.challenge.id} 资源回收不完整`)
        }
      }),
    )
    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, "调度控制面关闭时部分 Solver 资源回收失败")
    }
  }

  private hasChallenge(challengeId: string): boolean {
    return (
      this.active.has(challengeId) ||
      this.idleQueue.some((item) => item.challenge.id === challengeId) ||
      this.queue.some((item) => item.challenge.id === challengeId)
    )
  }

  private assertAdmissionCurrent(challengeId: string, stopVersion: number | undefined): void {
    this.assertNotShuttingDown()
    if (this.resetting.has(challengeId) || this.stopVersions.get(challengeId) !== stopVersion)
      throw new ContestSchedulerError("unavailable", "入队期间该题已被停止或重置")
    if (this.hasChallenge(challengeId))
      throw new ContestSchedulerError("already_queued", "该题已有正在执行或排队的求解目标")
  }

  private pump(): void {
    if (this.pumping || this.shuttingDown || !this.availability().available) return
    this.pumping = true
    try {
      // maxConcurrent 是本地 Solver/Sandbox 的硬上限。等待远程环境的 Run 仍占用
      // 自己的 Sandbox，因此 active 数永远不会像旧 execution-permit 模型一样膨胀。
      while (this.active.size < this.maxConcurrent && this.availability().available) {
        const index = this.queue.findIndex(
          (item) =>
            !this.resetting.has(item.challenge.id) &&
            (!item.requiresAuto || this.mode !== "stopped") &&
            this.canAdmit(item),
        )
        if (index < 0) break
        const [item] = this.queue.splice(index, 1)
        if (!item) break
        const active: ActiveItem = {
          challenge: item.challenge,
          source: item.source,
          lane: item.lane,
          requiresAuto: item.requiresAuto,
          attempt: item.resumeRun?.attempt ?? this.project.nextAttempt(item.challenge.id),
          phase: "preparing",
          startedAt: new Date().toISOString(),
          runId: null,
          cancelRequested: false,
          controller: new AbortController(),
          ...(item.resumeRun ? { resumeRun: item.resumeRun } : {}),
          ...(item.retryPrompt ? { retryPrompt: item.retryPrompt } : {}),
          ...(item.writeupRetry ? { writeupRetry: true } : {}),
        }
        if (!item.writeupRetry || !this.project.solveGoals.get(item.challenge.id))
          this.project.solveGoals.begin(item.challenge.id, item.requiresAuto)
        this.active.set(item.challenge.id, active)
        const operation = this.runItem(active)
          .catch((error: unknown) => {
            this.lastError = errorText(error)
          })
          .finally(() => {
            this.active.delete(item.challenge.id)
            this.pump()
            void this.reconcile().catch((error: unknown) => {
              this.lastError = errorText(error)
            })
          })
        active.operation = operation
      }
    } finally {
      this.pumping = false
      clearTimeout(this.wakeTimer)
      const next = this.project.solveGoals
        .list()
        .filter(
          (goal) =>
            goal.state === "active" &&
            goal.retryAt &&
            this.queue.some((item) => item.challenge.id === goal.challengeId),
        )
        .map((goal) => Date.parse(goal.retryAt!))
        .filter((at) => at > Date.now())
        .sort((a, b) => a - b)[0]
      if (next !== undefined)
        this.wakeTimer = setTimeout(() => this.pump(), Math.min(next - Date.now(), 2_147_483_647))
    }
  }

  private async runItem(active: ActiveItem): Promise<void> {
    let solver: CtfSolverAgent | undefined
    let continuation = active.source === "retry" || active.resumeRun !== undefined
    let failures = this.project.solveGoals.get(active.challenge.id)?.failures ?? 0
    let progress = 0
    let unsubscribe: (() => void) | undefined
    const delays = this.options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS
    const goal = this.project.solveGoals.get(active.challenge.id)!
    const canContinue = () =>
      !active.cancelRequested &&
      !this.shuttingDown &&
      this.project.solveGoals.get(active.challenge.id)?.id === goal.id &&
      this.project.solveGoals.get(active.challenge.id)?.state === "active"
    try {
      while (
        canContinue() ||
        ((active.writeupRetry || (solver && hasTerminalSubmission(solver))) &&
          !active.cancelRequested &&
          !this.shuttingDown)
      ) {
        const before = progress
        try {
          if (!solver) {
            const resumed = active.resumeRun
            if (this.project.isChallengeBlocked(active.challenge.id))
              this.project.reviveChallenge(active.challenge.id)
            const agent = await this.options.createAgentOptions({
              challenge: active.challenge,
              attempt: active.attempt,
              source: active.source,
            })
            if (active.cancelRequested || this.shuttingDown) return
            const options: CreateSolverOptions = {
              agent,
              compaction: false,
              writeup: this.options.writeup === true,
              executionGate: this.executionGate(active),
              requestGuard: {
                signal: active.controller.signal,
                canSend: () =>
                  !active.cancelRequested &&
                  !this.shuttingDown &&
                  !this.suspensionReason &&
                  (active.postprocessing ||
                    this.project.solveGoals.get(active.challenge.id)?.state === "active"),
              },
            }
            solver = resumed
              ? await this.project.resumeSolver(resumed.id, options)
              : await this.project.createSolver(active.challenge.id, {
                  ...options,
                  attempt: active.attempt,
                  source: active.source,
                })
            active.resumeRun = undefined
            active.solver = solver
            active.runId = solver.runId
            active.phase = "running"
            this.project.solveGoals.update(goal.id, {
              runId: solver.runId,
              reason: null,
              retryAt: null,
            })
            // Explicit retry instructions remain durable until the first prompt
            // has reached the session, including crashes during preparation/compaction.
            if (!active.retryPrompt && !active.writeupRetry)
              this.project.removeSchedulerChallenge(active.challenge.id)
            unsubscribe = solver.subscribe((event) => {
              if (
                event.type === "tool_execution_end" ||
                (event.type === "message_end" &&
                  event.message.role === "assistant" &&
                  event.message.stopReason !== "error" &&
                  event.message.stopReason !== "aborted")
              )
                progress++
            })
            if (active.cancelRequested || this.shuttingDown) return
          }
          if (
            active.writeupRetry ||
            hasTerminalSubmission(solver) ||
            this.hasRecordedSolveOutcome(active.challenge.id, solver.runId)
          ) {
            active.writeupRetry = false
            active.postprocessing = true
            this.project.solveGoals.update(goal.id, {
              state: "accepted",
              reason: null,
              retryAt: null,
            })
            if (this.options.writeup)
              await this.writeupAfterSubmission(active, solver, active.retryPrompt)
            else await solver.close("submitted")
            return
          }
          if (!this.availability().available) return
          let recovery = ""
          if ((await solver.contextPressure()).shouldCompact) {
            await solver.compact()
            progress++
            this.project.appendRunEvent(solver.runId, "solver_compaction", {
              compactPerformed: true,
              blockDelta: 0,
            })
            recovery = this.project.compactRecoveryPrompt(active.challenge.id, solver.runId)
          }
          const prompt =
            active.retryPrompt ??
            (continuation
              ? INCOMPLETE_CONTINUATION_PROMPT
              : typeof this.options.prompt === "function"
                ? await this.options.prompt({
                    challenge: active.challenge,
                    attempt: active.attempt,
                    source: active.source,
                  })
                : (this.options.prompt ?? "Start solving this CTF challenge."))
          active.retryPrompt = undefined
          const outcome = await runSolverPrompt({
            solver,
            prompt: recovery ? `${recovery}\n\n${prompt}` : prompt,
            abortGraceMs: this.options.abortGraceMs ?? 5_000,
            signal: active.controller.signal,
          })
          this.project.removeSchedulerChallenge(active.challenge.id)
          continuation = true
          if (outcome.kind === "submitted" || hasTerminalSubmission(solver)) continue
          if (!canContinue()) return
          if (progress > before) failures = 0
          const classification = classifySolverStop({
            stopReason: outcome.stopReason,
            ...(outcome.error ? { error: outcome.error } : {}),
          })
          if (classification.requiresConfiguration) {
            this.pauseGoal(goal.id, active, classification.detail ?? classification.kind)
            return
          }
          const failed = outcome.stopReason === "error" || outcome.stopReason === "aborted"
          failures = failed ? failures + 1 : 0
          if (failed && !classification.retryable && failures >= 3) {
            this.pauseGoal(goal.id, active, classification.detail ?? classification.kind)
            return
          }
          const delay = failed
            ? (delays[Math.min(failures - 1, delays.length - 1)] ?? 15_000)
            : (this.options.retryDelayMs ?? 2_000)
          this.project.appendRunEvent(
            solver.runId,
            failed ? "run_transient_failure" : "solver_continuation",
            {
              reason: classification.kind,
              failureNumber: failures,
              retryScheduled: true,
              retryDelayMs: delay,
              sameAttempt: true,
              goalId: goal.id,
            },
          )
          this.lastError = failed
            ? `${active.challenge.title}: ${outcome.error ?? outcome.stopReason}（将恢复求解）`
            : undefined
          this.project.solveGoals.update(goal.id, {
            failures,
            retryAt: new Date(Date.now() + delay).toISOString(),
            reason: failed ? (this.lastError ?? null) : null,
          })
          if (!(await this.waitForRetryDelay(active, delay))) return
          this.project.solveGoals.update(goal.id, { retryAt: null })
        } catch (error) {
          if (
            solver &&
            (hasTerminalSubmission(solver) ||
              this.hasRecordedSolveOutcome(active.challenge.id, solver.runId))
          ) {
            this.project.solveGoals.update(goal.id, {
              state: "accepted",
              reason: null,
              retryAt: null,
            })
            this.lastError = `${active.challenge.title}: ${errorText(error)}`
            return
          }
          if (!canContinue()) return
          if (progress > before) failures = 0
          failures++
          const classification = classifySolverStop({ error })
          // A failed creation may already have allocated a durable Run.
          if (!solver) {
            const latest = latestRecoverableRun(
              this.project.runs({ challengeId: active.challenge.id }),
            )
            if (latest) this.project.solveGoals.update(goal.id, { runId: latest.id })
          }
          if (
            classification.requiresConfiguration ||
            (!classification.retryable && failures >= 3)
          ) {
            this.pauseGoal(goal.id, active, errorText(error))
            return
          }
          const delay = Math.max(
            this.options.retryDelayMs ?? 2_000,
            this.options.infrastructureRetryDelayMs ?? 15_000,
            delays[Math.min(failures - 1, delays.length - 1)] ?? 0,
          )
          this.project.solveGoals.update(goal.id, {
            failures,
            retryAt: new Date(Date.now() + delay).toISOString(),
            reason: errorText(error),
          })
          if (!solver) return // Release the slot; the durable goal will re-enter the queue.
          this.project.appendRunEvent(solver.runId, "run_transient_failure", {
            reason: classification.kind,
            failureNumber: failures,
            retryScheduled: true,
            retryDelayMs: delay,
            sameAttempt: true,
            goalId: goal.id,
          })
          continuation = true
          if (!(await this.waitForRetryDelay(active, delay))) return
          this.project.solveGoals.update(goal.id, { retryAt: null })
        }
      }
    } finally {
      unsubscribe?.()
      try {
        if (solver && !solver.isClosed)
          await solver.close(
            hasTerminalSubmission(solver) ||
              this.hasRecordedSolveOutcome(active.challenge.id, solver.runId)
              ? "submitted"
              : active.cancelRequested && !this.shuttingDown
                ? "cancelled"
                : "interrupted",
            this.project.solveGoals.get(active.challenge.id)?.reason ?? undefined,
          )
      } catch (error) {
        const current = this.project.solveGoals.get(active.challenge.id)
        if (current?.state === "active")
          this.pauseGoal(goal.id, active, `资源回收需要处理: ${errorText(error)}`)
        this.lastError = errorText(error)
      } finally {
        active.solver = undefined
        const current = this.project.solveGoals.get(active.challenge.id)
        if (current?.state === "accepted" || current?.state === "stopped")
          this.project.removeSchedulerChallenge(active.challenge.id)
        if (
          !this.shuttingDown &&
          !this.resetting.has(active.challenge.id) &&
          current?.id === goal.id &&
          (current.state === "active" || current.state === "paused")
        ) {
          const run = current.runId
            ? this.project
                .runs({ challengeId: active.challenge.id })
                .find((candidate) => candidate.id === current.runId)
            : undefined
          this.enqueueChallenge(
            active.challenge,
            "retry",
            "execution",
            "normal",
            false,
            current.requiresAuto,
            run ? { resumeRun: run } : {},
          )
        }
      }
    }
  }

  private pauseGoal(id: string, active: ActiveItem, reason: string): void {
    this.project.solveGoals.update(id, { state: "paused", reason, retryAt: null })
    this.lastError = `${active.challenge.title}: ${reason}（进度已保存，修复后恢复）`
    if (active.runId)
      this.project.appendRunEvent(active.runId, "solve_goal_paused", { goalId: id, reason })
  }

  private hasRecordedSolveOutcome(challengeId: string, runId: string): boolean {
    return this.project
      .runs({ challengeId })
      .some((run) => run.id === runId && run.solveOutcome !== undefined)
  }

  private async writeupAfterSubmission(
    active: ActiveItem,
    solver: CtfSolverAgent,
    retryPrompt?: string,
  ): Promise<void> {
    await this.project.markRunWritingWriteup(solver.runId)
    await solver.prepareWriteup()
    let prompt = retryPrompt
      ? `${WRITEUP_PROMPT}\n\nAdditional instructions:\n${retryPrompt}`
      : WRITEUP_PROMPT
    let lastErrors: string[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await runSolverPrompt({
        solver,
        prompt,
        timeoutMs: 120_000,
        abortGraceMs: this.options.abortGraceMs ?? 5_000,
        ignoreExistingSubmission: true,
      })
      if (outcome.kind === "submitted") {
        lastErrors = ["writeup turn attempted another submission"]
      } else {
        const validation = await validateChallengeWriteup(solver.workspace)
        if (validation.valid) {
          await this.project.markRunWriteupStatus(solver.runId, "validated")
          await solver.close("submitted")
          return
        }
        lastErrors = validation.errors
        this.project.appendRunEvent(solver.runId, "writeup_validation_failed", {
          attempt: attempt + 1,
          errors: validation.errors,
          path: validation.path,
        })
      }
      prompt = [
        "The writeup validation failed. Fix /workspace/writeup.md and do not submit another flag.",
        `Validation errors: ${lastErrors.join("; ")}`,
        "Use the read/write/edit tools only, then finish the writeup turn.",
      ].join("\n")
      if (outcome.stopReason === "error" || outcome.stopReason === "aborted") {
        break
      }
    }
    const error = `writeup validation failed: ${lastErrors.join("; ")}`
    this.project.appendRunEvent(solver.runId, "writeup_failed", {
      challengeId: active.challenge.id,
      errors: lastErrors,
    })
    // Only the writeup failed: the accepted solve outcome recorded at submission stays.
    await this.project.markRunWriteupStatus(solver.runId, "failed")
    solver.discardTerminalSubmissionForWriteupFailure()
    await solver.close("failed", error)
  }

  private enqueueChallenge(
    challenge: ChallengeSummary,
    source: SchedulerQueueSource,
    stage: SchedulerQueueStage,
    lane: "normal" | "blocked",
    manualOverride: boolean,
    requiresAuto: boolean,
    options: { resumeRun?: RunRecord; retryPrompt?: string; writeupRetry?: boolean } = {},
  ): void {
    if (
      this.idleQueue.some((item) => item.challenge.id === challenge.id) ||
      this.queue.some((item) => item.challenge.id === challenge.id)
    ) {
      return
    }
    const persisted = this.project.enqueueSchedulerChallenge({
      challengeId: challenge.id,
      source,
      stage,
      lane,
      manualOverride,
      requiresAuto,
      ...(options.resumeRun ? { resumeRunId: options.resumeRun.id } : {}),
      ...(options.retryPrompt ? { retryPrompt: options.retryPrompt } : {}),
      ...(options.writeupRetry ? { writeupRetry: true } : {}),
    })
    const item: QueueItem = {
      challenge,
      source,
      stage,
      lane,
      manualOverride,
      requiresAuto,
      enqueuedAt: persisted.enqueuedAt,
      version: persisted.version,
      ...options,
    }
    const target = stage === "idle" ? this.idleQueue : this.queue
    if (manualOverride) target.unshift(item)
    else target.push(item)
  }

  private promoteIdleInMemory(): void {
    for (const item of this.idleQueue.splice(0)) {
      item.stage = "execution"
      item.requiresAuto = true
      this.queue.push(item)
    }
    this.syncPersistedQueueMetadata(this.project.schedulerQueue("execution"))
  }

  private canAdmit(item: QueueItem): boolean {
    const goal = this.project.solveGoals.get(item.challenge.id)
    if (
      !item.writeupRetry &&
      goal &&
      (goal.state !== "active" || (goal.retryAt && Date.parse(goal.retryAt) > Date.now()))
    )
      return false
    // 本地题和有附件题不消耗“预期远程槽”，可在平台实例已满时继续利用 Sandbox。
    if (item.challenge.needsEnv === false || item.challenge.hasAttachments === true) return true

    // 无附件环境题（以及平台无法判定的保守项）在创建 Sandbox 前先预留远程意图。
    // 不能只看协调器当前 occupied：同一轮 pump 内，刚启动的 Solver 尚未来得及调用
    // ctf_instance_start，否则仍会瞬间创建 maxConcurrent 个等环境的容器。
    const capacity = this.project.remoteEnvironmentCapacity()
    const admittedRemoteOnly = [...this.active.values()].filter(
      (active) => active.challenge.needsEnv !== false && active.challenge.hasAttachments !== true,
    ).length
    const available = Math.max(capacity.occupied, admittedRemoteOnly) < capacity.maximum
    if (!available && item.challenge.needsEnv === undefined) {
      this.discoverSchedulingHint(item)
    }
    return available
  }

  private discoverSchedulingHint(item: QueueItem): void {
    if (
      this.discoveringAdmission ||
      (this.admissionDiscoveryRetryAt.get(item.challenge.id) ?? 0) > Date.now()
    ) {
      return
    }
    this.discoveringAdmission = true
    void this.project
      .challengeSchedulingHint(item.challenge.id)
      .then((hint) => {
        this.admissionDiscoveryRetryAt.delete(item.challenge.id)
        Object.assign(item.challenge, hint)
      })
      .catch((error: unknown) => {
        this.admissionDiscoveryRetryAt.set(item.challenge.id, Date.now() + 30_000)
        this.lastError = `${item.challenge.title}: 无法读取调度提示：${errorText(error)}`
      })
      .finally(() => {
        this.discoveringAdmission = false
        this.pump()
      })
  }

  private executionGate(active: ActiveItem): NonNullable<CreateSolverOptions["executionGate"]> {
    return {
      suspend: () => this.suspendExecutionForEnvironment(active),
      resume: async (signal) => await this.resumeExecutionAfterEnvironment(active, signal),
    }
  }

  private suspendExecutionForEnvironment(active: ActiveItem): void {
    if (active.cancelRequested || this.shuttingDown) throw abortError("调度任务已取消")
    active.phase = "waiting_environment"
  }

  private async resumeExecutionAfterEnvironment(
    active: ActiveItem,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      active.cancelRequested ||
      this.shuttingDown ||
      signal?.aborted ||
      this.active.get(active.challenge.id) !== active
    ) {
      throw abortError("调度任务已取消")
    }
    active.phase = "running"
  }

  private waitForRetryDelay(active: ActiveItem, delayMs: number): Promise<boolean> {
    if (active.cancelRequested || this.shuttingDown) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const finish = (elapsed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (active.cancelRetryDelay === cancel) {
          active.cancelRetryDelay = undefined
        }
        resolve(elapsed)
      }
      const timeout = setTimeout(() => finish(true), delayMs)
      const cancel = () => finish(false)
      active.cancelRetryDelay = cancel
    })
  }

  private assertAvailable(): void {
    const availability = this.availability()
    if (availability.available) return
    throw new ContestSchedulerError("unavailable", availability.unavailableReason ?? "调度器未配置")
  }

  private availability(): SchedulerAvailability {
    if (this.suspensionReason) {
      return {
        available: false,
        unavailableReason: this.suspensionReason,
      }
    }
    return (
      this.options.availability?.() ?? {
        available: this.options.available ?? true,
        ...(this.options.unavailableReason
          ? { unavailableReason: this.options.unavailableReason }
          : {}),
      }
    )
  }

  private assertPlanningStopped(): void {
    if (this.mode === "stopped") return
    throw new ContestSchedulerError("scheduler_running", "请先暂停调度，再修改空闲队列")
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error("调度器正在关闭")
  }
}

function deduplicate(challenges: readonly ChallengeSummary[]): ChallengeSummary[] {
  const unique = new Map<string, ChallengeSummary>()
  for (const challenge of challenges)
    if (!unique.has(challenge.id)) unique.set(challenge.id, challenge)
  return [...unique.values()]
}

function latestRecoverableInterruptedRuns(runs: readonly RunRecord[]): Map<string, RunRecord> {
  const candidates = runs
    .filter((run) => run.status === "interrupted" && isRecoverableRun(run))
    .sort(compareRunOrder)
  return new Map(candidates.map((run) => [run.challengeId, run]))
}

/**
 * 所有非 blocked 的调度终态都可以沿用原 attempt 与 JSONL session。
 * 这既覆盖进程退出产生的 interrupted，也覆盖人工取消、超时和普通失败；
 * blocked 是唯一不自动恢复的终态。
 */
function latestRecoverableRun(runs: readonly RunRecord[]): RunRecord | undefined {
  const latest = [...runs].sort(compareRunOrder).at(-1)
  return latest && isRecoverableRun(latest) ? latest : undefined
}

function isRecoverableRun(run: RunRecord): boolean {
  return (
    RECOVERABLE_TERMINAL_RUN_STATUSES.has(run.status) &&
    RECOVERABLE_SCHEDULER_RUN_SOURCES.has(run.source)
  )
}

function compareRunOrder(left: RunRecord, right: RunRecord): number {
  return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
}

const RETRYABLE_RUN_STATUSES = new Set<RunRecord["status"]>([
  "failed",
  "timed_out",
  "cancelled",
  "closed",
  "interrupted",
  "blocked",
])

function positiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} 必须是正整数`)
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} 必须是非负整数`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" })
}
