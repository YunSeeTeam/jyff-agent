import { createHash } from "node:crypto"
import {
  codePointLength,
  codePointPrefix,
  jsonByteLength,
  SUBAGENT_PAGE_ERROR_MAX_CODE_POINTS,
  SUBAGENT_RESULT_ENVELOPE_MAX_BYTES,
  SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS,
  type SubagentResultKind,
  type SubagentResultPageDto,
  type SubagentResultQuery,
  sliceCodePoints,
  type ToolErrorEnvelope,
  toolError,
} from "../contracts/index.ts"
import type { SubagentRecord } from "./subagent-manager.ts"

/**
 * Report versions and code point pages (design 7.3). Pure: no UI helpers and
 * no storage; every page, version, and length comes from one record snapshot.
 */

export const SUBAGENT_REPORT_SCHEMA_VERSION = 2

const ACTIVE = new Set(["queued", "running"])

/**
 * Where the stored text came from. Records written before execution identities
 * exist are `legacy`: whether their text is complete is unknown.
 */
export function subagentResultKind(record: SubagentRecord): SubagentResultKind | undefined {
  return record.result ? "legacy" : undefined
}

/**
 * Version of the report a page belongs to, from fixed fields only (never
 * `updatedAt`), so paging across two different reports is always detected.
 */
export function subagentResultVersion(record: SubagentRecord): string {
  const fields = [
    SUBAGENT_REPORT_SCHEMA_VERSION,
    record.runId,
    record.id,
    "legacy",
    subagentResultKind(record) ?? null,
    record.result ?? "",
  ]
  return `v1:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`
}

/** Length of the stored report in code points. */
export function subagentResultLength(record: SubagentRecord): number {
  return record.result ? codePointLength(record.result) : 0
}

function invalid(message: string): ToolErrorEnvelope {
  return toolError("invalid_query", message, {
    retryable: false,
    nextAction: "Fix the request; do not fall back to reading everything at once.",
  })
}

/**
 * One page of a SubAgent report. The version check comes first: a page asked
 * for against an older report is refused even when the new report is empty.
 */
export function subagentResultPage(
  record: SubagentRecord,
  query: Omit<SubagentResultQuery, "agentId"> = {},
): SubagentResultPageDto | ToolErrorEnvelope {
  const offset = query.offset ?? 0
  const limit = query.limit ?? SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return invalid("offset must be a non-negative integer code point offset")
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS) {
    return invalid(`limit must be an integer from 1 to ${SUBAGENT_RESULT_PAGE_MAX_CODE_POINTS}`)
  }
  if (offset > 0 && !query.expectedResultVersion) {
    return invalid("offset > 0 requires expectedResultVersion from the first page")
  }
  const resultVersion = subagentResultVersion(record)
  if (query.expectedResultVersion && query.expectedResultVersion !== resultVersion) {
    return toolError("result_changed", "The report changed since that page was read", {
      retryable: true,
      nextAction: "Discard earlier pages and read again from offset 0.",
      details: { agentId: record.id, resultVersion },
    })
  }
  const text = record.result ?? ""
  const totalLength = codePointLength(text)
  if (offset > totalLength) {
    return toolError("invalid_offset", `offset ${offset} is past the end (${totalLength})`, {
      retryable: false,
      nextAction: "Use nextOffset from the previous page.",
      details: { totalLength },
    })
  }
  const result = sliceCodePoints(text, offset, limit)
  const end = offset + codePointLength(result)
  const kind = subagentResultKind(record)
  const page: SubagentResultPageDto = {
    schemaVersion: 2,
    agentId: record.id,
    status: record.status,
    ...(text ? {} : { state: ACTIVE.has(record.status) ? "result_pending" : "result_unavailable" }),
    ...(kind ? { resultKind: kind } : {}),
    resultVersion,
    offset,
    result,
    totalLength,
    ...(end < totalLength ? { nextOffset: end } : {}),
    hasMore: end < totalLength,
  }
  return withBoundedError(page, record.error)
}

/** The first page with default limits; it cannot be refused, so it never returns an error. */
export function firstSubagentResultPage(record: SubagentRecord): SubagentResultPageDto {
  const page = subagentResultPage(record)
  if ("error" in page) throw new Error(`first report page refused: ${page.error.code}`)
  return page
}

/**
 * Attach the failure text, shortening it (never the report) until the whole
 * envelope fits. A full page of the widest code points already fits on its own.
 */
function withBoundedError(
  page: SubagentResultPageDto,
  error: string | undefined,
): SubagentResultPageDto {
  if (!error) return page
  let limit = SUBAGENT_PAGE_ERROR_MAX_CODE_POINTS
  for (;;) {
    const candidate = { ...page, errorMessage: codePointPrefix(error, limit).text }
    if (jsonByteLength(candidate) <= SUBAGENT_RESULT_ENVELOPE_MAX_BYTES || limit === 0) {
      return limit === 0 ? page : candidate
    }
    limit = Math.floor(limit / 2)
  }
}
