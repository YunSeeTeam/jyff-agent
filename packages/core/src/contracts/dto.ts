/**
 * Frozen DTOs for the information contracts of stage 3 (design 7.2, 7.3, 9.1).
 *
 * Only shapes and limits are defined here; no producer emits them yet. Core,
 * the backend, and the WebUI import the same definitions so their field
 * conversions cannot drift apart.
 */

export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted"
  | "interrupted"

/** Where a SubAgent report came from. `assistant_final` says nothing about correctness. */
export type SubagentResultKind = "assistant_final" | "assistant_partial" | "tool_partial" | "legacy"

/** One page of a single report, and every automatic channel carrying one. */
export const SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS = 8_000
export const SUBAGENT_RESULT_ENVELOPE_MAX_BYTES = 96 * 1024
/** Per-item preview in lists, snapshots, and blocked finalization. */
export const SUBAGENT_LIST_PREVIEW_MAX_CODE_POINTS = 1_200
/** Fields around the report are cut first, so they never squeeze the promised first page. */
export const SUBAGENT_TASK_MAX_CODE_POINTS = 240
export const SUBAGENT_PAGE_ERROR_MAX_CODE_POINTS = 2_000
export const SUBAGENT_LIST_ERROR_MAX_CODE_POINTS = 200
export const SUBAGENT_ACTIVE_TOOL_MAX_CODE_POINTS = 64
export const SUBAGENT_LIST_MAX_BYTES = 16 * 1024
export const SUBAGENT_LIST_DEFAULT_LIMIT = 16
export const SUBAGENT_LIST_MAX_LIMIT = 32
/** Initial storage limit for a full report; a calibration starting point, not a measured value. */
export const SUBAGENT_REPORT_MAX_STORED_BYTES = 4 * 1024 * 1024

export const BLACKBOARD_PREVIEW_MAX_CODE_POINTS = 160
export const BLACKBOARD_INDEX_MAX_BYTES = 8 * 1024
export const BLACKBOARD_FULL_MAX_BYTES = 64 * 1024
export const BLACKBOARD_READ_DEFAULT_LIMIT = 8
export const BLACKBOARD_READ_MAX_LIMIT = 16
export const BLACKBOARD_READ_MAX_IDS = 16

/** Bounded SubAgent view for lists, SSE, and ChallengeDetails; no prompt, full result, or host paths. */
export interface SubagentSummaryDto {
  id: string
  runId: string
  role: string
  displayName: string
  status: SubagentStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  usage: {
    turns: number
    toolUses: number
    totalTokens: number
    inputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  /** Task description, cut to a bounded number of code points. */
  task: string
  taskTruncated: boolean
  /** Tool running right now, if any. */
  activeTool?: string
  /** Failure text, cut short; the report page carries a longer form. */
  errorMessage?: string
  resultPreview?: string
  resultKind?: SubagentResultKind
  resultVersion?: string
  /** Full report length in code points. */
  totalLength?: number
  hasMore: boolean
}

export interface SubagentListPageDto {
  schemaVersion: 2
  runId: string
  items: SubagentSummaryDto[]
  /** Opaque cursor bound to `runId`; absent on the last page. */
  nextCursor?: string
  /** Items after this page; they stay reachable through `nextCursor`. */
  omittedCount: number
}

/** Why a page has no report text: still working, or ended without one. */
export type SubagentResultState = "result_pending" | "result_unavailable"

export interface SubagentResultPageDto {
  schemaVersion: 2
  agentId: string
  /** Absent for legacy records written before execution identities existed. */
  executionId?: string
  status: SubagentStatus
  /** Present only when there is no report text yet or at all. */
  state?: SubagentResultState
  resultKind?: SubagentResultKind
  resultVersion: string
  /** Code point offset of this page. */
  offset: number
  result: string
  totalLength: number
  nextOffset?: number
  hasMore: boolean
  /** Failure text, bounded separately from the report. Not named `error`: that key marks an error envelope. */
  errorMessage?: string
}

export interface SubagentResultQuery {
  agentId: string
  offset?: number
  limit?: number
  /** Required when `offset > 0` so pages of two executions are never mixed. */
  expectedResultVersion?: string
}

export type BlackboardKind = "evidence" | "opportunity"
export type BlackboardView = "index" | "full"

export interface BlackboardReadInput {
  kind?: BlackboardKind
  view?: BlackboardView
  /** 1..16 positive safe integers; mutually exclusive with explicit `afterId`/`limit`. */
  ids?: number[]
  afterId?: number
  limit?: number
}

interface BlackboardEntryBase {
  id: number
  creatorRunId: string | null
  createdAt: string | null
  /** Opportunities only. */
  status?: string
  /** Versioned hash of the record's content fields; never includes `readAt`. */
  contentHash: string
}

export interface BlackboardIndexEntry extends BlackboardEntryBase {
  preview: string
  previewComplete: boolean
}

export interface BlackboardFullEntry extends BlackboardEntryBase {
  description: string
  sourceEvidenceIds?: number[]
  targetEvidenceId?: number | null
  resolution?: string | null
}

export interface BlackboardReadResult {
  schemaVersion: 2
  kind: BlackboardKind
  view: BlackboardView
  /** When this page was read; it is not a modification time. */
  readAt: string
  entries: Array<BlackboardIndexEntry | BlackboardFullEntry>
  /** Requested IDs with no record in this challenge (foreign IDs look identical). */
  missingIds: number[]
  /** Requested IDs that did not fit this page; read them again by ID. */
  omittedIds: number[]
  hasMore: boolean
  nextAfterId?: number
  counts?: { evidence: number; opportunities: number }
}
