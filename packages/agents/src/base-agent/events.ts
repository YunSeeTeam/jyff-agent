import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { BranchSummaryEntry, CompactionEntry } from "@earendil-works/pi-coding-agent"

/**
 * Events BaseAgent publishes to Core and the backend. Pi's per-turn events pass
 * through unchanged; session-level events keep the names Core already consumes,
 * so a Pi upgrade does not ripple into every subscriber.
 */
export type BaseAgentEvent =
  | AgentEvent
  | {
      type: "queue_update"
      steer: readonly string[]
      followUp: readonly string[]
      nextTurn: readonly string[]
    }
  | { type: "session_before_compact" }
  | { type: "session_compact"; compactionEntry: CompactionEntry; fromHook: boolean }
  | { type: "session_tree"; summaryEntry?: BranchSummaryEntry; fromHook: boolean }
  | {
      type: "retry_scheduled"
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: "model_update"; model: Model<Api> }
  | { type: "thinking_level_update"; level: ThinkingLevel }
  | { type: "tools_update"; activeToolNames: string[] }

export type BaseAgentEventListener = (
  event: BaseAgentEvent,
  signal?: AbortSignal,
) => Promise<void> | void
