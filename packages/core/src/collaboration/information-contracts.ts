/**
 * Narrow service interfaces frozen in stage 2 for the stage 3 information
 * contracts (design 7.2, 7.3, 8.3). Types only: RunStore and the managers
 * implement them in P1-a/P1-b, behind switches that stay off until then.
 */
import type {
  BlackboardReadInput,
  BlackboardReadResult,
  SubagentListPageDto,
  SubagentResultKind,
  SubagentResultPageDto,
  SubagentResultQuery,
} from "../contracts/dto.ts"
import type { ToolErrorEnvelope } from "../contracts/errors.ts"
import type { SubagentLifecyclePersistence } from "./subagent-manager.ts"

/** Challenge-scoped blackboard reads; the challenge comes from the caller's scope, never from input. */
export interface BlackboardReader {
  read(challengeId: string, input: BlackboardReadInput): BlackboardReadResult | ToolErrorEnvelope
}

export interface BeginExecution {
  runId: string
  subagentId: string
  /** The execution being replaced; `null` for a new or legacy record. */
  previousExecutionId: string | null
  newExecutionId: string
  status: string
  prompt: string
}

export interface ResultCommit {
  runId: string
  subagentId: string
  executionId: string
  status: string
  result: string | null
  resultKind: SubagentResultKind | null
  error: string | null
  completedAt: string
}

/** Identity plus counters; never touches the stored report or terminal fields. */
export interface ExecutionProgress {
  runId: string
  subagentId: string
  executionId: string
  turns: number
  toolUses: number
  totalTokens: number
  activeTool: string | null
}

export interface CommittedSubagent {
  runId: string
  subagentId: string
  executionId: string
  status: string
  resultVersion: string | null
}

/**
 * Durable SubAgent execution lifecycle. `commitResult` is a compare-and-set on
 * `(runId, subagentId, executionId)`: a stale execution gets `stale_execution`
 * and must never overwrite a newer one.
 */
// SQLite's synchronous transaction boundary lets spawn commit before returning.
// The record is a captured execution snapshot; progress SQL never writes report columns.
export type SubagentPersistence = SubagentLifecyclePersistence

/** Bounded reads shared by the agent tools and the HTTP routes. */
export interface SubagentReportReader {
  list(
    runId: string,
    page: { cursor?: string; limit?: number },
  ): SubagentListPageDto | ToolErrorEnvelope
  result(runId: string, query: SubagentResultQuery): SubagentResultPageDto | ToolErrorEnvelope
}
