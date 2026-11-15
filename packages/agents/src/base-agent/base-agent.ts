import { randomUUID } from "node:crypto"
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core"
import type { Api, AssistantMessage, ImageContent, Model, Models } from "@earendil-works/pi-ai"
import {
  type AgentSession,
  type AgentSessionEvent,
  type BranchSummaryEntry,
  type CompactionResult,
  DEFAULT_COMPACTION_SETTINGS,
  type SessionManager,
  shouldCompact,
} from "@earendil-works/pi-coding-agent"
import type { BaseAgentEvent, BaseAgentEventListener } from "./events.ts"
import { createPiSession } from "./runtime.ts"
import { type NativeSessionOptions, openAgentSession, recordActiveTools } from "./session.ts"
import type { AgentSkill } from "./skills.ts"
import { resolveThinkingLevel } from "./thinking.ts"
import { type ModelRequestScope, withModelRequestScope } from "./request-scope.ts"

/** Pi 0.82's harness default, kept for agents that do not supply a prompt. */
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."
/** Sandboxed tools resolve relative paths against the container workspace. */
const DEFAULT_WORKING_DIRECTORY = "/workspace"

export type CompactResult = CompactionResult

export interface BaseAgentOptions {
  requestScope?: () => ModelRequestScope
  session: NativeSessionOptions
  models: Models
  model: Model<Api>
  systemPrompt?: string
  /** Directory the model works in, shown in the prompt. A container path for sandboxed agents. */
  workingDirectory?: string
  thinkingLevel?: ThinkingLevel
  tools?: readonly AgentTool[]
  activeToolNames?: readonly string[]
  skills?: readonly AgentSkill[]
  initialMessages?: readonly AgentMessage[]
  compaction?: boolean
  compactionInstructions?: string
  compactionHooks?: CompactionLifecycleHooks
}

export interface PreparedBaseAgent {
  requestScope?: () => ModelRequestScope
  piSession: AgentSession
  sessionManager: SessionManager
  sessionPath: string
  restored: boolean
  tools: AgentTool[]
}

export interface ContextPressure {
  tokens: number
  contextWindow: number
  reserveTokens: number
  usableContext: number
  shouldCompact: boolean
}

export interface CompactionLifecycleHooks {
  before?: (pressure: ContextPressure) => Promise<void> | void
  after?: (result: CompactResult, pressure: ContextPressure) => Promise<void> | void
}

export interface BaseAgentRuntimeOptions {
  /** Retains the legacy prompt-time automatic check until Core owns turn supervision. */
  compaction?: boolean
  compactionInstructions?: string
  compactionHooks?: CompactionLifecycleHooks
}

export interface NavigateTreeResult {
  cancelled: boolean
  editorText?: string
  summaryEntry?: BranchSummaryEntry
}

/** Read-only view of the live runtime state, kept for callers of the former Agent API. */
export interface BaseAgentState {
  readonly systemPrompt: string
  readonly model: Model<Api>
  readonly thinkingLevel: ThinkingLevel
  readonly tools: AgentTool[]
  readonly messages: AgentMessage[]
  readonly isStreaming: boolean
}

interface QueuedUserMessage {
  text: string
  images?: ImageContent[]
}

function isSystemMessageEvent(event: AgentEvent): boolean {
  return (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "system"
  )
}

/** A read-only object whose properties are evaluated on every access. */
function liveState(read: { [K in keyof BaseAgentState]: () => BaseAgentState[K] }): BaseAgentState {
  const state = {}
  for (const [key, get] of Object.entries(read)) {
    Object.defineProperty(state, key, { get, enumerable: true })
  }
  return state as BaseAgentState
}

function withoutSystemMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role !== "system")
}

export async function prepareBaseAgent(options: BaseAgentOptions): Promise<PreparedBaseAgent> {
  const tools = [...(options.tools ?? [])]
  const names = tools.map((tool) => tool.name)
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
  if (duplicates.length > 0) throw new Error(`Duplicate tool name(s): ${duplicates.join(", ")}`)
  const unknown = (options.activeToolNames ?? []).filter((name) => !names.includes(name))
  if (unknown.length > 0) throw new Error(`Unknown tool(s): ${unknown.join(", ")}`)
  const opened = await openAgentSession({
    session: options.session,
    models: options.models,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools,
    activeToolNames: options.activeToolNames,
    initialMessages: options.initialMessages,
  })
  const piSession = await createPiSession({
    opened,
    models: options.models,
    // An empty prompt would make Pi fall back to its own coding-assistant prompt.
    systemPrompt: options.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    workingDirectory: options.workingDirectory ?? DEFAULT_WORKING_DIRECTORY,
    tools,
    skills: options.skills ?? [],
  })
  return {
    piSession,
    requestScope: options.requestScope,
    sessionManager: opened.sessionManager,
    sessionPath: options.session.path,
    restored: opened.restored,
    tools,
  }
}

/**
 * Shared Pi lifecycle for concrete agents, built on pi-coding-agent's
 * AgentSession. Domain agents add capabilities and cleanup only.
 */
export abstract class BaseAgent {
  readonly sessionPath: string
  readonly restored: boolean
  /** Persisted truth: the Pi session tree behind this agent. */
  readonly sessionManager: SessionManager
  protected readonly piSession: AgentSession
  readonly state: BaseAgentState
  private readonly registeredTools: AgentTool[]
  private readonly autoCompaction: boolean
  private readonly compactionInstructions?: string
  private readonly compactionHooks?: CompactionLifecycleHooks
  private readonly listeners = new Set<BaseAgentEventListener>()
  private readonly pendingNotifications = new Set<Promise<void>>()
  private readonly nextTurnQueue: QueuedUserMessage[] = []
  private steerQueue: readonly string[] = []
  private followUpQueue: readonly string[] = []
  private lastAssistantMessage?: AssistantMessage
  private readonly requestScope?: () => ModelRequestScope

  protected constructor(prepared: PreparedBaseAgent, options: BaseAgentRuntimeOptions = {}) {
    this.piSession = prepared.piSession
    const executionId = randomUUID()
    this.requestScope = () => ({ executionId, ...prepared.requestScope?.() })
    this.sessionManager = prepared.sessionManager
    this.sessionPath = prepared.sessionPath
    this.restored = prepared.restored
    this.registeredTools = prepared.tools
    this.autoCompaction = options.compaction !== false
    this.compactionInstructions = options.compactionInstructions
    this.compactionHooks = options.compactionHooks
    this.state = liveState({
      systemPrompt: () => this.systemPrompt,
      model: () => this.model,
      thinkingLevel: () => this.thinkingLevel,
      tools: () => this.tools,
      messages: () => withoutSystemMessages(this.piSession.messages),
      isStreaming: () => this.piSession.isStreaming,
    })
    // Core agent listeners are awaited and run after AgentSession has persisted
    // the message, so subscribers always observe the durable session state.
    this.piSession.agent.subscribe((event, signal) => this.handleAgentEvent(event, signal))
    this.piSession.subscribe((event) => this.handleSessionEvent(event))
  }

  /** Effective system prompt, including the skills and working-directory sections. */
  get systemPrompt(): string {
    return this.piSession.systemPrompt
  }
  get model(): Model<Api> {
    return this.piSession.agent.state.model as Model<Api>
  }
  get thinkingLevel(): ThinkingLevel {
    return this.piSession.thinkingLevel
  }
  get tools(): AgentTool[] {
    return [...this.registeredTools]
  }
  get activeTools(): AgentTool[] {
    const byName = new Map(this.registeredTools.map((tool) => [tool.name, tool]))
    return this.piSession
      .getActiveToolNames()
      .flatMap((name) => (byName.has(name) ? [byName.get(name) as AgentTool] : []))
  }

  /** Conversation messages on the current branch; the prompt's system messages are omitted. */
  async getMessages(): Promise<AgentMessage[]> {
    return withoutSystemMessages(this.sessionManager.buildSessionContext().messages)
  }

  /** Run one prompt to completion and return its final assistant message. */
  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
    return withModelRequestScope(this.requestScope?.(), () => this.promptInScope(text, options))
  }

  private async promptInScope(
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<AssistantMessage> {
    await this.compactIfNeeded()
    // nextTurn messages travel with the prompt that consumes them, so they stay
    // ordinary visible user content instead of hidden custom entries.
    const queued = this.nextTurnQueue.splice(0)
    if (queued.length > 0) this.publishQueueUpdate()
    const images = [...queued.flatMap((item) => item.images ?? []), ...(options?.images ?? [])]
    this.lastAssistantMessage = undefined
    await this.piSession.prompt([...queued.map((item) => item.text), text].join("\n\n"), {
      expandPromptTemplates: false,
      source: "rpc",
      ...(images.length > 0 ? { images } : {}),
    })
    await this.settleNotifications()
    const message = this.lastAssistantMessage
    if (!message) throw new Error("Agent prompt completed without an assistant message")
    return message
  }

  steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (!this.piSession.isStreaming) {
      return Promise.reject(new Error("Cannot steer while idle"))
    }
    return this.piSession.steer(text, options?.images, { source: "rpc" }).then(() => undefined)
  }
  /** Deliver an asynchronous system notice even if its original turn has already ended. */
  async promptOrSteer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.piSession.isStreaming) await this.steer(text, options)
    else await this.prompt(text, options)
  }
  followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (!this.piSession.isStreaming) {
      return Promise.reject(new Error("Cannot follow up while idle"))
    }
    return this.piSession.followUp(text, options?.images, { source: "rpc" }).then(() => undefined)
  }
  /** Queue a user message for the next prompt without starting a turn. */
  async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.nextTurnQueue.push({ text, ...(options?.images ? { images: options.images } : {}) })
    this.publishQueueUpdate()
  }
  /** Route human input according to Pi's queue contract. */
  queueUserMessage(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    return this.piSession.isStreaming ? this.steer(text, options) : this.nextTurn(text, options)
  }
  subscribe(listener: BaseAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const previous = this.thinkingLevel
    this.piSession.setThinkingLevel(resolveThinkingLevel(this.model, level))
    if (this.thinkingLevel !== previous) await this.settleNotifications()
  }
  async setModel(model: Model<Api>): Promise<void> {
    await this.piSession.setModel(model)
    this.publish({ type: "model_update", model })
    await this.settleNotifications()
  }
  async setActiveTools(toolNames: string[]): Promise<void> {
    const known = new Set(this.registeredTools.map((tool) => tool.name))
    const unknown = toolNames.filter((name) => !known.has(name))
    if (unknown.length > 0) throw new Error(`Unknown tool(s): ${unknown.join(", ")}`)
    this.piSession.setActiveToolsByName(toolNames)
    recordActiveTools(this.sessionManager, this.piSession.getActiveToolNames())
    this.publish({ type: "tools_update", activeToolNames: this.piSession.getActiveToolNames() })
    await this.settleNotifications()
  }
  async contextPressure(): Promise<ContextPressure> {
    // Unknown right after a compaction until the next response reports usage.
    const tokens = this.piSession.getContextUsage()?.tokens ?? 0
    const contextWindow = this.model.contextWindow
    const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens
    const usableContext = contextWindow - reserveTokens
    return {
      tokens,
      contextWindow,
      reserveTokens,
      usableContext,
      shouldCompact:
        usableContext > 0 && shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS),
    }
  }
  async compact(customInstructions?: string): Promise<CompactResult> {
    const pressure = await this.contextPressure()
    await this.compactionHooks?.before?.(pressure)
    const result = await withModelRequestScope(
      { ...this.requestScope?.(), purpose: "compaction" },
      () => this.piSession.compact(customInstructions ?? this.compactionInstructions),
    )
    const entry = this.sessionManager.getLeafEntry()
    if (entry?.type === "compaction") {
      this.publish({
        type: "session_compact",
        compactionEntry: entry,
        fromHook: entry.fromHook ?? false,
      })
    }
    await this.settleNotifications()
    await this.compactionHooks?.after?.(result, pressure)
    return result
  }
  async navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    },
  ): Promise<NavigateTreeResult> {
    const result = await withModelRequestScope(
      { ...this.requestScope?.(), purpose: "branch_summary" },
      () => this.piSession.navigateTree(targetId, options),
    )
    if (!result.cancelled) {
      this.publish({
        type: "session_tree",
        ...(result.summaryEntry ? { summaryEntry: result.summaryEntry } : {}),
        fromHook: result.summaryEntry?.fromHook ?? false,
      })
      await this.settleNotifications()
    }
    return {
      cancelled: result.cancelled,
      ...(result.editorText === undefined ? {} : { editorText: result.editorText }),
      ...(result.summaryEntry ? { summaryEntry: result.summaryEntry } : {}),
    }
  }
  /** Stop the current run and drop queued steering, like Pi 0.82's harness. */
  async abort(): Promise<void> {
    this.piSession.clearQueue()
    this.piSession.abortCompaction()
    this.piSession.abortBranchSummary()
    await this.piSession.abort()
    await this.settleNotifications()
  }
  async waitForIdle(): Promise<void> {
    await this.piSession.waitForIdle()
    await this.settleNotifications()
  }
  hasQueuedMessages(): boolean {
    return this.steerQueue.length + this.followUpQueue.length + this.nextTurnQueue.length > 0
  }
  hasQueuedSteerMessages(): boolean {
    return this.steerQueue.length > 0
  }

  private async compactIfNeeded(): Promise<void> {
    if (!this.autoCompaction) return
    const pressure = await this.contextPressure()
    // Pi's defaults assume a context window larger than reserveTokens. A
    // smaller model must still run instead of compacting an empty session.
    if (pressure.shouldCompact) await this.compact()
  }

  private async handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
    if (isSystemMessageEvent(event)) return
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.lastAssistantMessage = event.message
    }
    await this.dispatch(event, signal)
  }

  private handleSessionEvent(event: AgentSessionEvent): void {
    if (event.type === "queue_update") {
      this.steerQueue = event.steering
      this.followUpQueue = event.followUp
      this.publishQueueUpdate()
    } else if (event.type === "compaction_start") {
      this.publish({ type: "session_before_compact" })
    } else if (event.type === "summarization_retry_scheduled") {
      this.publish({
        type: "retry_scheduled",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      })
    } else if (event.type === "thinking_level_changed") {
      this.publish({ type: "thinking_level_update", level: event.level })
    }
  }

  private publishQueueUpdate(): void {
    this.publish({
      type: "queue_update",
      steer: [...this.steerQueue],
      followUp: [...this.followUpQueue],
      nextTurn: this.nextTurnQueue.map((item) => item.text),
    })
  }

  /** Session-level events arrive synchronously; their listeners settle before the next await point. */
  private publish(event: BaseAgentEvent): void {
    const pending = this.dispatch(event).catch(() => undefined)
    this.pendingNotifications.add(pending)
    void pending.finally(() => this.pendingNotifications.delete(pending))
  }

  private async dispatch(event: BaseAgentEvent, signal?: AbortSignal): Promise<void> {
    for (const listener of this.listeners) await listener(event, signal)
  }

  private async settleNotifications(): Promise<void> {
    while (this.pendingNotifications.size > 0) {
      await Promise.allSettled(this.pendingNotifications)
    }
  }
}
