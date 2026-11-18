import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  type AgentSkill,
  availableSubagentRoles,
  type BaseAgentEvent,
  type ChallengeCapability,
  type ChallengeInfo,
  type CtfSolverAgent,
  CtfSubagent,
  collectSubagentReport,
  markSubagentExecution,
  type ExecutionOutcome,
  resolveSubagentRole,
  type Sandbox,
  type SubagentRole,
} from "@ctf-agent/agents"
import { subagentCompletionNotificationPrompt } from "@ctf-agent/prompts"
import { DockerExecutionEnv } from "@ctf-agent/sandbox"
import type { AgentOptions, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import {
  SUBAGENT_LIST_MAX_LIMIT,
  SUBAGENT_REPORT_MAX_STORED_BYTES,
  type SubagentResultKind,
  toolError,
  SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS,
  type SubagentListPageDto,
  type SubagentResultPageDto,
  type SubagentStatus,
  type ToolErrorEnvelope,
  type ToolErrorCode,
  codePointPrefix,
} from "../contracts/index.ts"
import { SUBAGENT_MODEL_PREVIEW_CODE_POINTS, subagentListPage } from "./subagent-projection.ts"
import { firstSubagentResultPage, subagentResultPage } from "./subagent-report.ts"
import type { FixedAttachmentReads } from "../project/fixed-attachment-reads.ts"
import type { LocalProcessManager } from "../project/local-process-manager.ts"

export type { SubagentStatus } from "../contracts/index.ts"

export interface SubagentRecord {
  id: string
  runId: string
  role: string
  displayName: string
  description: string
  status: SubagentStatus
  background: boolean
  prompt: string
  sessionPath: string
  containerCwd: string
  executionId?: string
  resultKind?: SubagentResultKind
  result?: string
  error?: string
  activeTool?: string
  turns: number
  toolUses: number
  totalTokens: number
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export type SubagentLifecycleEvent =
  | "created"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted"
  | "steered"

export interface SubagentLifecyclePersistence {
  beginExecution(record: SubagentRecord, previousExecutionId: string | null): SubagentRecord
  commitResult(record: SubagentRecord): SubagentRecord
  recordProgress(record: SubagentRecord): void
}

export interface SubagentManagerOptions {
  requestGuard?: import("@ctf-agent/agents").ModelRequestGuard
  projectId: string
  runId: string
  runDirectory: string
  challenge: ChallengeInfo
  capability?: ChallengeCapability
  sandbox: Sandbox
  agent: AgentOptions
  roles: ReadonlyMap<string, SubagentRole>
  skills?: readonly AgentSkill[]
  skillsForRole?: (role: string) => Promise<readonly AgentSkill[]>
  blackboardReadTool?: AgentTool
  fixedAttachmentReads?: FixedAttachmentReads
  localProcessManager?: LocalProcessManager
  fullSubagentReports?: boolean
  persistence?: SubagentLifecyclePersistence
  /** 可选注入 web-access 工具，SubAgent 通过 role.tools 白名单决定是否启用。 */
  webAccessTools?: AgentTool[]
  /** 可选注入 ShellPoop 反弹 shell 工具，SubAgent 通过 role.tools 白名单决定是否启用。 */
  shellpoopTools?: AgentTool[]
  maxConcurrent?: number
  onRecord?: (record: SubagentRecord, event: SubagentLifecycleEvent) => Promise<void> | void
  /** 将 Pi 的细粒度运行事件转发给控制面，不参与 Agent 生命周期结算。 */
  onAgentEvent?: (
    record: SubagentRecord,
    event: BaseAgentEvent,
    model: { provider: string; id: string } | undefined,
  ) => void
}

interface ManagedSubagent {
  record: SubagentRecord
  role: SubagentRole
  agent?: CtfSubagent
  promise: Promise<SubagentRecord>
  resolve: (record: SubagentRecord) => void
  reject: (error: unknown) => void
  storageError?: Error
  unsubscribe?: () => void
  launchPromise?: Promise<void>
  pendingReport?: { result: string; resultKind: SubagentResultKind }
  resultConsumed: boolean
  hardAborted: boolean
}

interface QueuedRun {
  managed: ManagedSubagent
  prompt: string
}

const TERMINAL = new Set<SubagentStatus>([
  "completed",
  "failed",
  "cancelled",
  "aborted",
  "interrupted",
])

/** Per-run worker fleet adapted from pi-subagents' manager/runner split. */
export class CtfSubagentManager {
  private readonly records = new Map<string, ManagedSubagent>()
  private readonly queue: QueuedRun[] = []
  private readonly maxConcurrent: number
  private runningBackground = 0
  private parent?: CtfSolverAgent
  private finalizing = false
  private closing = false
  private closePromise?: Promise<void>

  constructor(private readonly options: SubagentManagerOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4)
  }

  attachParent(parent: CtfSolverAgent): void {
    this.parent = parent
  }

  availableRoles(): SubagentRole[] {
    return availableSubagentRoles(this.options.roles)
  }

  /** Reattach persisted terminal workers so their JSONL sessions can be resumed. */
  restore(records: readonly SubagentRecord[]): void {
    for (const record of records) {
      if (record.runId !== this.options.runId || this.records.has(record.id)) continue
      if (!TERMINAL.has(record.status)) continue
      const role = resolveSubagentRole(this.options.roles, record.role)
      if (!role) continue
      const managed = this.managed(snapshot(record), role)
      managed.resolve(snapshot(record))
      this.records.set(record.id, managed)
    }
  }

  spawn(input: {
    role: string
    prompt: string
    description: string
    background: boolean
  }): SubagentRecord {
    if (this.closing || this.finalizing) {
      throw new Error("SubAgent manager 正在收尾或关闭")
    }
    const role = resolveSubagentRole(this.options.roles, input.role)
    if (!role) {
      throw new Error(
        `未知或已禁用的 SubAgent 类型: ${input.role}; 可用类型: ${this.availableRoles()
          .map((item) => item.name)
          .join(", ")}`,
      )
    }
    const prompt = boundedText(input.prompt, "prompt", 32_000)
    const description = boundedText(input.description, "description", 240)
    const id = randomUUID()
    const now = new Date().toISOString()
    const record: SubagentRecord = {
      id,
      executionId: randomUUID(),
      runId: this.options.runId,
      role: role.name,
      displayName: role.displayName,
      description,
      status: input.background ? "queued" : "running",
      background: input.background,
      prompt,
      sessionPath: join(this.options.runDirectory, "subagents", id, "session.jsonl"),
      containerCwd: `/workspace/subagents/${id}`,
      turns: 0,
      toolUses: 0,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      createdAt: now,
      updatedAt: now,
    }
    const committed = this.begin(record, null)
    const managed = this.managed(committed, role)
    this.records.set(id, managed)
    this.emit(managed, "created")
    if (input.background && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ managed, prompt })
    } else {
      this.launch(managed, prompt, true)
    }
    return snapshot(managed.record)
  }

  async resume(id: string, prompt: string, background: boolean): Promise<SubagentRecord> {
    if (this.closing || this.finalizing) {
      throw new Error("SubAgent manager 正在收尾或关闭")
    }
    return this.restart(id, prompt, background)
  }

  private async restart(
    id: string,
    prompt: string,
    background: boolean,
    bypassQueue = false,
  ): Promise<SubagentRecord> {
    const previous = this.records.get(id)
    if (!previous || !TERMINAL.has(previous.record.status)) {
      throw new Error(`SubAgent ${id} 不存在、尚未完成或会话不可恢复`)
    }
    if (previous.storageError) throw previous.storageError
    const nextPrompt = boundedText(prompt, "prompt", 32_000)
    // Await old transport teardown before reusing its session. Re-check identity
    // afterwards so two concurrent resumes cannot both claim the old execution.
    await previous.launchPromise
    await previous.agent?.waitForIdle()
    if (this.records.get(id) !== previous)
      throw lifecycleError("stale_execution", "Execution already replaced")
    previous.unsubscribe?.()
    const record: SubagentRecord = {
      ...previous.record,
      executionId: randomUUID(),
      background,
      status: background ? "queued" : "running",
      prompt: nextPrompt,
      result: undefined,
      resultKind: undefined,
      error: undefined,
      activeTool: undefined,
      startedAt: undefined,
      completedAt: undefined,
      updatedAt: new Date().toISOString(),
    }
    const committed = this.begin(record, previous.record.executionId ?? null)
    const managed = this.managed(committed, previous.role)
    this.records.set(id, managed)
    this.emit(managed, "created")
    if (!bypassQueue && background && this.runningBackground >= this.maxConcurrent) {
      this.queue.push({ managed, prompt: nextPrompt })
    } else this.launch(managed, nextPrompt, true)
    return background ? snapshot(managed.record) : await managed.promise
  }

  private managed(record: SubagentRecord, role: SubagentRole): ManagedSubagent {
    let resolve!: (value: SubagentRecord) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<SubagentRecord>((done, fail) => {
      resolve = done
      reject = fail
    })
    // Background failures remain observable via wait without unhandled rejections.
    void promise.catch(() => undefined)
    return { record, role, promise, resolve, reject, resultConsumed: false, hardAborted: false }
  }

  private current(managed: ManagedSubagent): boolean {
    return this.records.get(managed.record.id) === managed && !managed.storageError
  }

  private begin(record: SubagentRecord, previousExecutionId: string | null): SubagentRecord {
    try {
      return this.options.persistence?.beginExecution(record, previousExecutionId) ?? record
    } catch (error) {
      if (hasLifecycleCode(error, "stale_execution")) throw error
      throw lifecycleError(
        "report_persistence_failed",
        `Cannot begin SubAgent execution: ${errorText(error)}`,
      )
    }
  }

  get(id: string): SubagentRecord | undefined {
    const managed = this.records.get(id)
    if (managed?.storageError) throw managed.storageError
    return managed ? snapshot(managed.record) : undefined
  }

  list(): SubagentRecord[] {
    return [...this.records.values()]
      .map(({ record }) => snapshot(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /** One bounded page of this Run's SubAgents, as the model sees it. */
  listPage(query: { cursor?: string; limit?: number }): SubagentListPageDto | ToolErrorEnvelope {
    return subagentListPage(this.options.runId, this.list(), query, {
      previewCodePoints: SUBAGENT_MODEL_PREVIEW_CODE_POINTS,
    })
  }

  async wait(id: string, signal?: AbortSignal): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed) throw new Error(`SubAgent 不存在: ${id}`)
    if (managed.storageError) throw managed.storageError
    const result = TERMINAL.has(managed.record.status)
      ? managed.record
      : await abortable(managed.promise, signal)
    if (this.records.get(id) !== managed)
      throw lifecycleError("execution_changed", "Execution changed while waiting")
    if (managed.storageError) throw managed.storageError
    managed.resultConsumed = true
    return snapshot(result)
  }

  async waitForTool(
    id: string,
    signal?: AbortSignal,
    interruptOnSteer = true,
  ): Promise<{ record: SubagentRecord; waitInterrupted: boolean }> {
    const current = this.records.get(id)
    if (!current) throw new Error(`SubAgent 不存在: ${id}`)
    if (!interruptOnSteer || TERMINAL.has(current.record.status)) {
      return { record: await this.wait(id, signal), waitInterrupted: false }
    }
    const parent = this.parent
    if (!parent) {
      return { record: await this.wait(id, signal), waitInterrupted: false }
    }

    const completed = new AbortController()
    const combined = signal ? AbortSignal.any([signal, completed.signal]) : completed.signal
    try {
      return await Promise.race([
        this.wait(id, combined).then((record) => ({
          record,
          waitInterrupted: false,
        })),
        waitForParentSteer(parent, combined).then(() => {
          if (this.records.get(id) !== current)
            throw lifecycleError("execution_changed", "Execution changed while waiting")
          return { record: snapshot(current.record), waitInterrupted: true }
        }),
      ])
    } finally {
      completed.abort()
    }
  }

  async steer(id: string, message: string): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed) {
      throw new Error(`SubAgent ${id} 当前不可接收 steer`)
    }
    const nextMessage = boundedText(message, "message", 4_000)
    if (TERMINAL.has(managed.record.status)) {
      // finished worker 的内存 Agent 可能已释放；强制从原 JSONL session
      // 重新打开，保证 steer 延续同一 worker，而不是创建新会话。
      await managed.agent?.waitForIdle()
      managed.agent = undefined
      return this.resume(id, nextMessage, true)
    }
    if (!managed.agent || managed.record.status !== "running") {
      throw new Error(`SubAgent ${id} 当前不可接收 steer`)
    }
    await managed.agent.promptOrSteer(nextMessage)
    managed.record.updatedAt = new Date().toISOString()
    this.emit(managed, "steered")
    return snapshot(managed.record)
  }

  async broadcast(message: string): Promise<void> {
    const nextMessage = boundedText(message, "message", 4_000)
    await Promise.allSettled(
      [...this.records.values()]
        .filter((managed) => managed.record.status === "running" && managed.agent)
        .map(async (managed) => {
          await managed.agent?.promptOrSteer(nextMessage)
          managed.record.updatedAt = new Date().toISOString()
          this.emit(managed, "steered")
        }),
    )
  }

  async cancel(id: string): Promise<SubagentRecord> {
    const managed = this.records.get(id)
    if (!managed) throw new Error(`SubAgent ${id} 不存在`)
    if (managed.storageError) throw managed.storageError
    if (TERMINAL.has(managed.record.status)) return snapshot(managed.record)
    const index = this.queue.findIndex((item) => item.managed === managed)
    if (index >= 0) this.queue.splice(index, 1)
    // Commit the first terminal state synchronously, before awaiting abort.
    let captureError: unknown
    try {
      this.captureLatestResult(managed, "cancelled")
    } catch (error) {
      captureError = error
      managed.pendingReport = undefined
      managed.record.error = errorText(error)
      managed.resultConsumed = true
      managed.reject(error)
    }
    const failures: unknown[] = []
    try {
      this.finish(managed, "cancelled")
    } catch (error) {
      failures.push(error)
    }
    try {
      await managed.agent?.abort()
    } catch (error) {
      failures.push(error)
    }
    const cleanup = await Promise.allSettled([
      this.options.fixedAttachmentReads?.closeOwner(id),
      this.options.localProcessManager?.closeOwner(id),
    ])
    for (const result of cleanup) if (result.status === "rejected") failures.push(result.reason)
    if (captureError && failures.length === 0) throw captureError
    if (captureError) failures.unshift(captureError)
    if (failures.length) throw new AggregateError(failures, "SubAgent cancellation failed")
    return snapshot(managed.record)
  }

  /**
   * blocking 收尾屏障：先停止未启动任务，再中止当前 turn，并从同一 JSONL
   * session 启动一个明确的最终报告 turn。
   * 超时 worker 会先抓取最新回复再中止，返回时所有子任务都已进入终态。
   */
  async finalize(reportPrompt: string, graceMs: number): Promise<SubagentRecord[]> {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new Error("SubAgent finalization graceMs must be non-negative")
    }
    this.finalizing = true
    const queued = this.list().filter((record) => record.status === "queued")
    await Promise.allSettled(queued.map((record) => this.cancel(record.id)))

    const running = this.list().filter((record) => record.status === "running")
    await Promise.allSettled(
      running.map(async (record) => {
        const managed = this.records.get(record.id)
        await this.cancel(record.id)
        await managed?.agent?.waitForIdle()
      }),
    )
    await Promise.allSettled(
      running.map((record) => this.restart(record.id, reportPrompt, true, true)),
    )
    if (running.length > 0 && graceMs > 0) {
      await settleWithin(
        running.map((record) => this.wait(record.id)),
        graceMs,
      )
    }

    const unfinished = this.list().filter(
      (record) => record.status === "running" || record.status === "queued",
    )
    await Promise.allSettled(unfinished.map((record) => this.cancel(record.id)))
    await Promise.allSettled(
      unfinished.map(
        (record) => this.records.get(record.id)?.agent?.waitForIdle() ?? Promise.resolve(),
      ),
    )
    return this.list()
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = this.stopPending()
    return this.closePromise
  }

  private async stopPending(): Promise<void> {
    const pending = this.list().filter((record) => !TERMINAL.has(record.status))
    await Promise.allSettled(
      pending.map(async (record) => {
        const managed = this.records.get(record.id)
        if (!managed) return
        // A winner has already ended the run. Persist the latest usable worker
        // output, but do not inject cancellation notices into the writeup turn.
        managed.resultConsumed = true
        if (!TERMINAL.has(managed.record.status)) await this.cancel(record.id)
      }),
    )
    await Promise.allSettled(
      [...this.records.values()].map(({ agent }) => agent?.waitForIdle() ?? Promise.resolve()),
    )
  }

  /** Reserve a background slot synchronously, before any async session setup. */
  private launch(managed: ManagedSubagent, prompt: string, initialize: boolean): void {
    const background = managed.record.background
    if (background) this.runningBackground++
    managed.launchPromise = this.executeLaunch(managed, prompt, initialize).finally(() => {
      if (background) {
        this.runningBackground = Math.max(0, this.runningBackground - 1)
      }
      this.drainQueue()
    })
  }

  private async executeLaunch(
    managed: ManagedSubagent,
    prompt: string,
    initialize: boolean,
  ): Promise<void> {
    try {
      if (initialize) {
        const env = new DockerExecutionEnv(this.options.sandbox)
        const created = await env.createDir(managed.record.containerCwd, {
          recursive: true,
        })
        if (!created.ok) throw created.error
        managed.agent = await CtfSubagent.create({
          requestScope: () => ({
            ...this.options.requestGuard,
            executionId: managed.record.executionId,
            canSend: () =>
              this.current(managed) &&
              !TERMINAL.has(managed.record.status) &&
              (this.options.requestGuard?.canSend?.() ?? true),
          }),
          projectId: this.options.projectId,
          runId: this.options.runId,
          runDirectory: this.options.runDirectory,
          subagentId: managed.record.id,
          containerCwd: managed.record.containerCwd,
          challenge: this.options.challenge,
          capability: this.options.capability,
          sandbox: this.options.sandbox,
          agent: this.options.agent,
          role: managed.role,
          skills: this.options.skillsForRole
            ? await this.options.skillsForRole(managed.role.name)
            : this.options.skills,
          blackboardReadTool: this.options.blackboardReadTool,
          fixedAttachmentReadTool: this.options.fixedAttachmentReads?.tool(managed.record.id),
          processTools: this.options.localProcessManager?.tools(managed.record.id),
          webAccessTools: this.options.webAccessTools,
          shellpoopTools: this.options.shellpoopTools,
        })
        if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
        markSubagentExecution(managed.agent.sessionManager, managed.record.executionId!)
        this.subscribe(managed, managed.agent)
      }
      if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
      await this.run(managed, prompt)
    } catch (error) {
      if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
      if (hasLifecycleCode(error, "report_persistence_failed")) {
        this.failPersistence(managed, error)
        return
      }
      try {
        this.captureLatestResult(managed, "failed")
      } catch {
        managed.pendingReport = undefined
      }
      managed.record.error = errorText(error)
      if (hasLifecycleCode(error, "report_storage_limit")) {
        managed.resultConsumed = true
        managed.reject(error)
      }
      try {
        this.finish(managed, managed.hardAborted ? "aborted" : "failed")
      } catch (failure) {
        this.failPersistence(managed, failure)
      }
    }
  }

  private async run(managed: ManagedSubagent, prompt: string): Promise<void> {
    managed.record.status = "running"
    managed.record.startedAt = new Date().toISOString()
    managed.record.updatedAt = managed.record.startedAt
    this.progress(managed)
    if (managed.storageError) throw managed.storageError
    this.emit(managed, "started")
    const message = await managed.agent!.prompt(prompt)
    if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
    const reason: string = message.stopReason
    const status: SubagentStatus =
      managed.hardAborted || reason === "aborted"
        ? "aborted"
        : reason === "cancel" || reason === "cancelled"
          ? "cancelled"
          : reason !== "stop"
            ? "failed"
            : "completed"
    if (status !== "completed")
      managed.record.error = message.errorMessage || `Agent stopped: ${reason}`
    this.captureLatestResult(managed, status === "completed" ? "completed" : "failed")
    this.finish(managed, status)
  }

  private captureLatestResult(
    managed: ManagedSubagent,
    outcome: ExecutionOutcome = "cancelled",
  ): void {
    if (!this.current(managed) || TERMINAL.has(managed.record.status) || !managed.agent) return
    const report = collectSubagentReport(
      managed.agent.sessionManager,
      managed.record.executionId!,
      outcome,
    )
    if (!report.available) {
      if (report.reason === "boundary_unavailable")
        throw lifecycleError(
          "result_boundary_unavailable",
          report.detail ?? "Missing execution boundary",
        )
      return
    }
    if (Buffer.byteLength(report.text, "utf8") > SUBAGENT_REPORT_MAX_STORED_BYTES) {
      managed.pendingReport = undefined
      throw lifecycleError(
        "report_storage_limit",
        "Report exceeds the 4 MiB storage limit; inspect the session",
      )
    }
    managed.pendingReport = {
      result: this.options.fullSubagentReports ? report.text : report.text.slice(0, 8_000),
      resultKind: report.kind,
    }
  }

  private progress(managed: ManagedSubagent): void {
    if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
    try {
      this.options.persistence?.recordProgress(snapshot(managed.record))
    } catch (error) {
      this.failPersistence(managed, error)
    }
  }

  private failPersistence(managed: ManagedSubagent, cause: unknown): void {
    const error = lifecycleError(
      "report_persistence_failed",
      `SubAgent persistence failed: ${errorText(cause)}`,
    )
    managed.storageError = error
    managed.reject(error)
    void managed.agent?.abort().catch(() => undefined)
  }

  private subscribe(managed: ManagedSubagent, agent: CtfSubagent): void {
    managed.unsubscribe = agent.subscribe((event) => {
      if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
      try {
        const model = managed.agent?.model
        this.options.onAgentEvent?.(
          snapshot(managed.record),
          event,
          model ? { provider: model.provider, id: model.id } : undefined,
        )
      } catch {
        // 实时 UI 是旁路能力，不能因订阅者异常打断 SubAgent。
      }
      this.captureProgress(managed, event)
    })
  }

  private captureProgress(managed: ManagedSubagent, event: BaseAgentEvent): void {
    let changed = false
    if (event.type === "turn_end") {
      managed.record.turns++
      changed = true
    }
    if (event.type === "tool_execution_start") {
      managed.record.activeTool = event.toolName
      changed = true
    }
    if (event.type === "tool_execution_end") {
      managed.record.toolUses++
      managed.record.activeTool = undefined
      changed = true
    }
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
      managed.record.totalTokens += event.message.usage.totalTokens
      managed.record.inputTokens = (managed.record.inputTokens ?? 0) + event.message.usage.input
      managed.record.cacheReadTokens =
        (managed.record.cacheReadTokens ?? 0) + event.message.usage.cacheRead
      managed.record.cacheWriteTokens =
        (managed.record.cacheWriteTokens ?? 0) + event.message.usage.cacheWrite
      changed = true
    }
    if (!changed) return
    managed.record.updatedAt = new Date().toISOString()
    this.progress(managed)
    this.emit(managed, "progress")
  }

  private finish(managed: ManagedSubagent, status: SubagentStatus): void {
    if (!this.current(managed) || TERMINAL.has(managed.record.status)) return
    const now = new Date().toISOString()
    const next = {
      ...managed.record,
      ...managed.pendingReport,
      status,
      activeTool: undefined,
      completedAt: now,
      updatedAt: now,
    }
    try {
      managed.record = this.options.persistence?.commitResult(next) ?? next
    } catch (error) {
      this.failPersistence(managed, error)
      throw managed.storageError
    }
    status = managed.record.status
    const event: SubagentLifecycleEvent =
      status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : status === "aborted"
            ? "aborted"
            : "failed"
    this.emit(managed, event)
    managed.resolve(snapshot(managed.record))
    if (managed.record.background && !managed.resultConsumed) {
      void this.notifyParent(managed.record).catch(() => undefined)
    }
  }

  private drainQueue(): void {
    while (
      !this.closing &&
      !this.finalizing &&
      this.queue.length > 0 &&
      this.runningBackground < this.maxConcurrent
    ) {
      const next = this.queue.shift()
      if (next?.managed.record.status !== "queued") continue
      this.launch(next.managed, next.prompt, true)
    }
  }

  private emit(managed: ManagedSubagent, event: SubagentLifecycleEvent): void {
    try {
      void Promise.resolve(this.options.onRecord?.(snapshot(managed.record), event)).catch(
        () => undefined,
      )
    } catch {
      /* Telemetry must not interrupt durable lifecycle publication. */
    }
  }

  private async notifyParent(record: SubagentRecord): Promise<void> {
    const parent = this.parent
    if (!parent || parent.isClosed) return
    const page = firstSubagentResultPage(record)
    const notification = {
      id: record.id,
      role: record.role,
      status: record.status,
      output: page.result || page.errorMessage || "No output",
      ...(page.nextOffset === undefined
        ? {}
        : {
            resultVersion: page.resultVersion,
            totalLength: page.totalLength,
            nextOffset: page.nextOffset,
          }),
    }
    await parent.promptOrSteer(subagentCompletionNotificationPrompt(notification))
  }
}

function lifecycleError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function hasLifecycleCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function settleWithin(promises: Promise<unknown>[], milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds)
    void Promise.allSettled(promises).then(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

/** Main-Agent tools use pi-subagents-compatible names and argument conventions. */
export function createSubagentManagerTools(manager: CtfSubagentManager): AgentTool[] {
  const types = manager
    .availableRoles()
    .map((role) => role.name)
    .join(", ")
  const tools: AgentTool[] = [
    {
      name: "Agent",
      label: "Launch SubAgent",
      description: `Launch a specialized CTF SubAgent. Available types: ${types}.`,
      parameters: Type.Object({
        subagent_type: Type.String(),
        prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
        description: Type.String({ minLength: 1, maxLength: 240 }),
        run_in_background: Type.Optional(Type.Boolean()),
        resume: Type.Optional(Type.String()),
      }),
      async execute(_id, raw, signal) {
        const params = raw as {
          subagent_type: string
          prompt: string
          description: string
          run_in_background?: boolean
          resume?: string
        }
        const background = params.run_in_background === true
        const extra: Record<string, boolean> = background ? { background: true } : {}
        if (params.resume) {
          const record = await manager.resume(params.resume, params.prompt, background)
          return pageToolResult(firstSubagentResultPage(record), extra)
        }
        const record = manager.spawn({
          role: params.subagent_type,
          prompt: params.prompt,
          description: params.description,
          background,
        })
        return pageToolResult(
          firstSubagentResultPage(background ? record : await manager.wait(record.id, signal)),
          extra,
        )
      },
    },
    {
      name: "get_subagent_result",
      label: "Get SubAgent Result",
      description: `Read or wait for a background SubAgent result, one page of at most ${SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS} code points. When hasMore is true, call again with offset=nextOffset and expected_result_version=resultVersion; a result_changed error means the report changed, so read again from offset 0. Waiting stops when the parent receives a steer unless interrupt_on_steer is false; the worker keeps running.`,
      parameters: Type.Object({
        agent_id: Type.String(),
        wait: Type.Optional(Type.Boolean()),
        interrupt_on_steer: Type.Optional(Type.Boolean()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS }),
        ),
        expected_result_version: Type.Optional(Type.String({ maxLength: 128 })),
      }),
      async execute(_id, raw, signal) {
        const params = raw as {
          agent_id: string
          wait?: boolean
          interrupt_on_steer?: boolean
          offset?: number
          limit?: number
          expected_result_version?: string
        }
        const query = {
          ...(params.offset === undefined ? {} : { offset: params.offset }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.expected_result_version === undefined
            ? {}
            : { expectedResultVersion: params.expected_result_version }),
        }
        if (params.wait) {
          const waited = await manager.waitForTool(
            params.agent_id,
            signal,
            params.interrupt_on_steer !== false,
          )
          const page = subagentResultPage(waited.record, query)
          if ("error" in page) return errorToolResult(page)
          return pageToolResult(page, {
            waitInterrupted: waited.waitInterrupted,
            ...(waited.waitInterrupted ? { waitInterruptedReason: "parent_steer_queued" } : {}),
          })
        }
        const record = manager.get(params.agent_id)
        if (!record) throw new Error(`SubAgent 不存在: ${params.agent_id}`)
        const page = subagentResultPage(record, query)
        return "error" in page ? errorToolResult(page) : pageToolResult(page)
      },
    },
    {
      name: "steer_subagent",
      label: "Steer SubAgent",
      description:
        "Send new guidance to a running SubAgent, or resume a finished SubAgent from its persisted session.",
      parameters: Type.Object({
        agent_id: Type.String(),
        message: Type.String({ minLength: 1, maxLength: 4_000 }),
      }),
      async execute(_id, raw) {
        const params = raw as { agent_id: string; message: string }
        return pageToolResult(
          firstSubagentResultPage(await manager.steer(params.agent_id, params.message)),
        )
      },
    },
    {
      name: "cancel_subagent",
      label: "Cancel SubAgent",
      description: "Cancel a queued or running SubAgent.",
      parameters: Type.Object({ agent_id: Type.String() }),
      async execute(_id, raw) {
        return pageToolResult(
          firstSubagentResultPage(await manager.cancel((raw as { agent_id: string }).agent_id)),
        )
      },
    },
    {
      name: "list_subagents",
      label: "List SubAgents",
      description:
        "List this run's SubAgents in creation order with short report previews. A page holds what fits in 16 KiB, so it can hold fewer than limit; pass nextCursor back as cursor until it is absent. Read a full report with get_subagent_result.",
      parameters: Type.Object({
        cursor: Type.Optional(Type.String({ maxLength: 1_024 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SUBAGENT_LIST_MAX_LIMIT })),
      }),
      async execute(_id, raw) {
        const params = raw as { cursor?: string; limit?: number }
        const page = manager.listPage({
          ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        })
        return "error" in page ? errorToolResult(page) : listToolResult(page)
      },
    },
  ]
  return tools.map((tool) => ({
    ...tool,
    async execute(...args: Parameters<AgentTool["execute"]>) {
      try {
        return await tool.execute(...args)
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string")
          throw error
        return errorToolResult(
          toolError(error.code as ToolErrorCode, codePointPrefix(error.message, 2_000).text, {
            retryable: error.code === "execution_changed" || error.code === "stale_execution",
            nextAction:
              "Read the current execution from offset 0; storage failures require operator recovery.",
          }),
        )
      }
    },
  }))
}

/**
 * The model reads the page itself; `details` (kept in the session and shown by
 * the WebUI) hold only identifiers, versions, and counts, never report text.
 * `id` stays for WebUI cards that link a tool call to its SubAgent.
 */
function pageToolResult(
  page: SubagentResultPageDto,
  extra: Record<string, string | boolean> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify({ ...page, ...extra }) }],
    details: {
      schemaVersion: page.schemaVersion,
      id: page.agentId,
      agentId: page.agentId,
      status: page.status,
      ...(page.state ? { state: page.state } : {}),
      resultVersion: page.resultVersion,
      offset: page.offset,
      totalLength: page.totalLength,
      ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      hasMore: page.hasMore,
      ...extra,
    },
  }
}

function listToolResult(page: SubagentListPageDto): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(page) }],
    details: {
      schemaVersion: page.schemaVersion,
      runId: page.runId,
      ids: page.items.map((item) => item.id),
      omittedCount: page.omittedCount,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    },
  }
}

function errorToolResult(envelope: ToolErrorEnvelope): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    details: { ...envelope.error },
    isError: true,
  }
}

function snapshot(record: SubagentRecord): SubagentRecord {
  return { ...record }
}

function boundedText(value: string, field: string, max: number): string {
  const text = value.trim()
  if (!text) throw new Error(`${field} 不能为空`)
  if (text.length > max) throw new Error(`${field} 长度不能超过 ${max}`)
  return text
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function waitForParentSteer(parent: CtfSolverAgent, signal: AbortSignal): Promise<void> {
  if (parent.hasQueuedSteerMessages()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribe = () => {}
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      unsubscribe()
      operation()
    }
    const onAbort = () => finish(() => reject(signal.reason))
    unsubscribe = parent.subscribe((event) => {
      if (event.type === "queue_update" && event.steer.length > 0) {
        finish(resolve)
      }
    })
    signal.addEventListener("abort", onAbort, { once: true })
    // 避免检查和订阅之间到达的 steer 被漏掉。
    if (parent.hasQueuedSteerMessages()) finish(resolve)
  })
}
