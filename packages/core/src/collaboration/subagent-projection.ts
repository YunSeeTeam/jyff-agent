import { activeSubagentsPrompt } from "@ctf-agent/prompts"
import {
  codePointPrefix,
  fitContiguousPrefix,
  SUBAGENT_ACTIVE_TOOL_MAX_CODE_POINTS,
  SUBAGENT_LIST_DEFAULT_LIMIT,
  SUBAGENT_LIST_ERROR_MAX_CODE_POINTS,
  SUBAGENT_LIST_MAX_BYTES,
  SUBAGENT_LIST_MAX_LIMIT,
  SUBAGENT_LIST_PREVIEW_MAX_CODE_POINTS,
  SUBAGENT_TASK_MAX_CODE_POINTS,
  type SubagentListPageDto,
  type SubagentSummaryDto,
  type ToolErrorEnvelope,
  toolError,
} from "../contracts/index.ts"
import type { SubagentRecord } from "./subagent-manager.ts"
import {
  subagentResultKind,
  subagentResultLength,
  subagentResultVersion,
} from "./subagent-report.ts"

/**
 * Bounded projections of SubAgent records (design 7.3, 9.2). Every automatic
 * channel (tools, prompts, HTTP, the WebUI) goes through these instead of
 * serializing records, which carry the prompt, the report, and host paths.
 */

/** Preview length for lists the model reads; leaves room for several items per page. */
export const SUBAGENT_MODEL_PREVIEW_CODE_POINTS = 600

const NAME_MAX_CODE_POINTS = 128
const CURSOR_MAX_LENGTH = 1_024
const ACTIVE = new Set(["queued", "running"])

export interface SubagentSummaryOptions {
  /** Report preview length; 0 leaves the preview out (metadata only). */
  previewCodePoints: number
}

export function subagentSummary(
  record: SubagentRecord,
  options: SubagentSummaryOptions,
): SubagentSummaryDto {
  const previewLimit = Math.min(
    Math.max(0, Math.floor(options.previewCodePoints)),
    SUBAGENT_LIST_PREVIEW_MAX_CODE_POINTS,
  )
  const task = codePointPrefix(record.description, SUBAGENT_TASK_MAX_CODE_POINTS)
  const result = record.result ?? ""
  const preview = previewLimit > 0 && result ? codePointPrefix(result, previewLimit) : undefined
  const kind = subagentResultKind(record)
  return {
    id: record.id,
    runId: record.runId,
    ...(record.executionId ? { executionId: record.executionId } : {}),
    role: codePointPrefix(record.role, NAME_MAX_CODE_POINTS).text,
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.reviewId ? { reviewId: record.reviewId } : {}),
    displayName: codePointPrefix(record.displayName, NAME_MAX_CODE_POINTS).text,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    usage: {
      turns: record.turns,
      toolUses: record.toolUses,
      totalTokens: record.totalTokens,
      inputTokens: record.inputTokens ?? 0,
      cacheReadTokens: record.cacheReadTokens ?? 0,
      cacheWriteTokens: record.cacheWriteTokens ?? 0,
    },
    task: task.text,
    taskTruncated: task.truncated,
    ...(record.activeTool
      ? {
          activeTool: codePointPrefix(record.activeTool, SUBAGENT_ACTIVE_TOOL_MAX_CODE_POINTS).text,
        }
      : {}),
    ...(record.error
      ? { errorMessage: codePointPrefix(record.error, SUBAGENT_LIST_ERROR_MAX_CODE_POINTS).text }
      : {}),
    ...(preview ? { resultPreview: preview.text } : {}),
    ...(kind ? { resultKind: kind } : {}),
    resultVersion: subagentResultVersion(record),
    totalLength: subagentResultLength(record),
    hasMore: result ? (preview?.truncated ?? true) : false,
  }
}

function compareCreation(left: SubagentRecord, right: SubagentRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

interface CursorPosition {
  createdAt: string
  id: string
}

/** Opaque, URL-safe, and bound to one Run: a cursor from another Run is refused. */
export function encodeSubagentCursor(runId: string, record: SubagentRecord): string {
  return Buffer.from(
    JSON.stringify({ v: 1, r: runId, c: record.createdAt, i: record.id }),
    "utf8",
  ).toString("base64url")
}

function invalidCursor(message: string): ToolErrorEnvelope {
  return toolError("invalid_query", message, {
    retryable: false,
    nextAction: "Omit cursor to start from the first page, or pass nextCursor unchanged.",
  })
}

function decodeSubagentCursor(runId: string, cursor: string): CursorPosition | ToolErrorEnvelope {
  if (cursor.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return invalidCursor("cursor is malformed")
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    return invalidCursor("cursor is malformed")
  }
  const { v, r, c, i } = (value ?? {}) as Record<string, unknown>
  if (
    v !== 1 ||
    typeof r !== "string" ||
    typeof c !== "string" ||
    typeof i !== "string" ||
    c.length === 0 ||
    c.length > 64 ||
    i.length === 0 ||
    i.length > 128
  ) {
    return invalidCursor("cursor is malformed")
  }
  if (r !== runId) return invalidCursor("cursor belongs to another Run")
  return { createdAt: c, id: i }
}

function isAfter(record: SubagentRecord, position: CursorPosition): boolean {
  return (
    record.createdAt > position.createdAt ||
    (record.createdAt === position.createdAt && record.id > position.id)
  )
}

function listPage(
  runId: string,
  entries: ReadonlyArray<{ record: SubagentRecord; summary: SubagentSummaryDto }>,
  remainingAfter: number,
  cursorable: boolean,
): SubagentListPageDto {
  const last = entries.at(-1)?.record
  return {
    schemaVersion: 2,
    runId,
    items: entries.map(({ summary }) => summary),
    ...(cursorable && remainingAfter > 0 && last
      ? { nextCursor: encodeSubagentCursor(runId, last) }
      : {}),
    omittedCount: remainingAfter,
  }
}

/** The longest contiguous run of entries that fits the list budget; the first entry always fits. */
function fitEntries(
  runId: string,
  entries: ReadonlyArray<{ record: SubagentRecord; summary: SubagentSummaryDto }>,
  total: number,
  cursorable: boolean,
): SubagentListPageDto {
  const fit = fitContiguousPrefix(entries, SUBAGENT_LIST_MAX_BYTES, (page) =>
    listPage(runId, page, total - page.length, cursorable),
  )
  if (!fit.firstItemTooLarge) {
    return listPage(runId, fit.items, total - fit.items.length, cursorable)
  }
  // Even an oversized first item must appear, or a cursor would loop on empty pages.
  const first = entries[0]
  if (!first) return listPage(runId, [], total, cursorable)
  const minimal = {
    record: first.record,
    summary: subagentSummary(first.record, { previewCodePoints: 0 }),
  }
  return listPage(runId, [minimal], total - 1, cursorable)
}

/**
 * One page of a Run's SubAgents in creation order (immutable `createdAt, id`).
 * Pages hold a contiguous prefix within 16 KiB, so they may carry fewer than
 * `limit` items; `nextCursor` reaches everything that was left out.
 */
export function subagentListPage(
  runId: string,
  records: readonly SubagentRecord[],
  query: { cursor?: string; limit?: number },
  options: SubagentSummaryOptions,
): SubagentListPageDto | ToolErrorEnvelope {
  const limit = query.limit ?? SUBAGENT_LIST_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUBAGENT_LIST_MAX_LIMIT) {
    return toolError(
      "invalid_query",
      `limit must be an integer from 1 to ${SUBAGENT_LIST_MAX_LIMIT}`,
      {
        retryable: false,
        nextAction: "Fix limit and read the page again.",
      },
    )
  }
  const ordered = records.filter((record) => record.runId === runId).sort(compareCreation)
  let start = 0
  if (query.cursor !== undefined) {
    const position = decodeSubagentCursor(runId, query.cursor)
    if ("error" in position) return position
    const index = ordered.findIndex((record) => isAfter(record, position))
    start = index < 0 ? ordered.length : index
  }
  const rest = ordered.slice(start)
  const entries = rest
    .slice(0, limit)
    .map((record) => ({ record, summary: subagentSummary(record, options) }))
  return fitEntries(runId, entries, rest.length, true)
}

/**
 * The SubAgents a recovery or finalization prompt shows: active ones first,
 * then the most recent. It is a view, not a cursor page; `omittedCount` says
 * how many are left for `list_subagents` to enumerate.
 */
export function subagentSnapshot(
  runId: string,
  records: readonly SubagentRecord[],
  options: SubagentSummaryOptions,
): SubagentListPageDto {
  const own = records.filter((record) => record.runId === runId)
  const active = own.filter((record) => ACTIVE.has(record.status)).sort(compareCreation)
  const ended = own
    .filter((record) => !ACTIVE.has(record.status))
    .sort((left, right) => compareCreation(right, left))
  const entries = [...active, ...ended]
    .slice(0, SUBAGENT_LIST_MAX_LIMIT)
    .map((record) => ({ record, summary: subagentSummary(record, options) }))
  return fitEntries(runId, entries, own.length, false)
}

/** The snapshot as a prompt block, saying how many SubAgents it left out and how to reach them. */
export function subagentSnapshotPrompt(snapshot: SubagentListPageDto): string {
  const block = activeSubagentsPrompt(snapshot)
  if (snapshot.omittedCount === 0) return block
  return [
    block,
    `${snapshot.omittedCount} more SubAgents are not shown here. Call list_subagents to enumerate them, and get_subagent_result to read a full report.`,
  ].join("\n")
}
