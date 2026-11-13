import { createHash } from "node:crypto"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import { blackboardSnapshotPrompt } from "@ctf-agent/prompts"
import {
  BLACKBOARD_FULL_MAX_BYTES,
  BLACKBOARD_INDEX_MAX_BYTES,
  BLACKBOARD_PREVIEW_MAX_CODE_POINTS,
  BLACKBOARD_READ_DEFAULT_LIMIT,
  BLACKBOARD_READ_MAX_IDS,
  BLACKBOARD_READ_MAX_LIMIT,
  codePointLength,
  codePointPrefix,
  jsonByteLength,
  toolError,
  type BlackboardReadInput,
  type BlackboardReadResult,
  type ToolErrorEnvelope,
} from "../contracts/index.ts"
import {
  BLACKBOARD_DESCRIPTION_MAX_LENGTH,
  BLACKBOARD_SOURCE_MAX_ITEMS,
  type EvidenceRecord,
  type OpportunityRecord,
  type RunStore,
} from "../persistence/run-store.ts"

type ReadResult = BlackboardReadResult | ToolErrorEnvelope

function invalid(message: string): ToolErrorEnvelope {
  return toolError("invalid_query", message, {
    retryable: false,
    nextAction:
      "Use kind/view and either ids or afterId/limit; IDs must be safe positive integers.",
  })
}

export function validateBlackboardReadInput(
  input: BlackboardReadInput,
): ToolErrorEnvelope | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid("Expected an object")
  if (
    Object.keys(input).some((key) => !["kind", "view", "ids", "afterId", "limit"].includes(key))
  ) {
    return invalid("Unknown query field")
  }
  if (input.kind !== undefined && input.kind !== "evidence" && input.kind !== "opportunity")
    return invalid("Invalid kind")
  if (input.view !== undefined && input.view !== "index" && input.view !== "full")
    return invalid("Invalid view")
  if (input.ids !== undefined) {
    if (input.afterId !== undefined || input.limit !== undefined)
      return invalid("ids cannot be combined with afterId or limit")
    if (
      !Array.isArray(input.ids) ||
      input.ids.length < 1 ||
      input.ids.length > BLACKBOARD_READ_MAX_IDS ||
      input.ids.some((id) => !Number.isSafeInteger(id) || id < 1)
    )
      return invalid("Invalid ids")
  }
  if (input.afterId !== undefined && (!Number.isSafeInteger(input.afterId) || input.afterId < 0))
    return invalid("Invalid afterId")
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > BLACKBOARD_READ_MAX_LIMIT)
  )
    return invalid("Invalid limit")
  return undefined
}

/** Shared by the model tool, HTTP route and bounded compaction snapshot. */
export function readBlackboard(
  runStore: Pick<RunStore, "readBlackboardRecords">,
  challengeId: string,
  input: BlackboardReadInput = {},
): ReadResult {
  const error = validateBlackboardReadInput(input)
  if (error) return error
  const kind = input.kind ?? "evidence"
  const view = input.view ?? "index"
  const ids = input.ids ? [...new Set(input.ids)] : undefined
  const limit = input.limit ?? BLACKBOARD_READ_DEFAULT_LIMIT
  const { records, counts } = runStore.readBlackboardRecords(challengeId, kind, {
    ...(ids ? { ids } : { afterId: input.afterId ?? 0 }),
    limit: ids ? ids.length : limit + 1,
  })
  const byId = new Map(records.map((record) => [record.id, record]))
  const ordered = ids
    ? ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    : records.slice(0, limit)
  const missingIds = ids?.filter((id) => !byId.has(id)) ?? []
  const page = (length: number): BlackboardReadResult => {
    const selected = ordered.slice(0, length)
    const hasMore = length < ordered.length || (!ids && records.length > limit)
    return {
      schemaVersion: 2,
      kind,
      view,
      readAt,
      counts,
      entries: selected.map(project),
      missingIds,
      omittedIds: ids ? ordered.slice(length).map((record) => record.id) : [],
      hasMore,
      ...(!ids && hasMore && selected.length
        ? { nextAfterId: selected[selected.length - 1]!.id }
        : {}),
    }
  }
  const project = (
    record: EvidenceRecord | OpportunityRecord,
  ): BlackboardReadResult["entries"][number] => {
    const opportunity = "status" in record ? record : undefined
    const sourceIds = opportunity ? [...opportunity.sourceEvidenceIds].sort((a, b) => a - b) : []
    const fields = [
      1,
      kind,
      record.id,
      record.description,
      opportunity?.status ?? null,
      opportunity?.resolution ?? null,
      sourceIds,
      opportunity?.targetEvidenceId ?? null,
    ]
    const base = {
      id: record.id,
      creatorRunId: record.runId ?? null,
      createdAt: record.createdAt ?? null,
      ...(opportunity ? { status: opportunity.status } : {}),
      contentHash: `v1:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`,
    }
    return view === "index"
      ? {
          ...base,
          preview: codePointPrefix(record.description, BLACKBOARD_PREVIEW_MAX_CODE_POINTS).text,
          previewComplete:
            codePointLength(record.description) <= BLACKBOARD_PREVIEW_MAX_CODE_POINTS,
        }
      : {
          ...base,
          description: record.description,
          ...(opportunity
            ? {
                sourceEvidenceIds: sourceIds,
                targetEvidenceId: opportunity.targetEvidenceId,
                resolution: opportunity.resolution,
              }
            : {}),
        }
  }
  const readAt = new Date().toISOString()
  const maxBytes = view === "index" ? BLACKBOARD_INDEX_MAX_BYTES : BLACKBOARD_FULL_MAX_BYTES
  // Measure the actual tool envelope, including JSON escaping in its text content.
  let length = 0
  for (; length < ordered.length; length++) {
    if (jsonByteLength(blackboardReadToolResult(page(length + 1))) > maxBytes) break
  }
  if (!length && ordered.length)
    return toolError("entry_too_large", "Blackboard entry exceeds the page budget", {
      retryable: false,
      nextAction: "Ask a maintainer to inspect this entry; do not retry the same empty page.",
      details: { id: ordered[0]!.id, kind, view },
    })
  return page(length)
}

export function blackboardReadToolResult(
  page: ReadResult,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(page) }],
    details:
      "error" in page
        ? { code: page.error.code }
        : {
            schemaVersion: page.schemaVersion,
            kind: page.kind,
            view: page.view,
            returnedCount: page.entries.length,
            hasMore: page.hasMore,
          },
    ...("error" in page ? { isError: true } : {}),
  }
}

export function createBlackboardReadTool(
  runStore: Pick<RunStore, "readBlackboardRecords">,
  challengeId: string,
): AgentTool {
  assertBlackboardReaderCapacity()
  return {
    name: "blackboard_read",
    label: "Read Blackboard",
    description:
      "Read recorded evidence and observations for this challenge. {} returns the first evidence index page. Use kind=opportunity for leads, view=full with ids to read complete records, or afterId=nextAfterId to continue. Re-read key records and compare contentHash before relying on them. Records are claims to verify, not proof.",
    parameters: Type.Object(
      {
        kind: Type.Optional(Type.Union([Type.Literal("evidence"), Type.Literal("opportunity")])),
        view: Type.Optional(Type.Union([Type.Literal("index"), Type.Literal("full")])),
        ids: Type.Optional(
          Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), {
            minItems: 1,
            maxItems: BLACKBOARD_READ_MAX_IDS,
          }),
        ),
        afterId: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: BLACKBOARD_READ_MAX_LIMIT })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params) {
      return blackboardReadToolResult(
        readBlackboard(runStore, challengeId, params as BlackboardReadInput),
      )
    },
  }
}

let capacityChecked = false
/** Fail at tool assembly if changed write limits no longer fit one full record. */
export function assertBlackboardReaderCapacity(): void {
  if (capacityChecked) return
  const result = readBlackboard(
    {
      readBlackboardRecords: () => ({
        records: [
          {
            id: Number.MAX_SAFE_INTEGER,
            challengeId: "capacity",
            runId: "r".repeat(128),
            createdAt: "2000-01-01T00:00:00.000Z",
            description: "\u0001".repeat(BLACKBOARD_DESCRIPTION_MAX_LENGTH),
            status: "concluded",
            resolution: "confirmed",
            concludedAt: "2000-01-01T00:00:00.000Z",
            sourceEvidenceIds: Array(BLACKBOARD_SOURCE_MAX_ITEMS).fill(Number.MAX_SAFE_INTEGER),
            targetEvidenceId: Number.MAX_SAFE_INTEGER,
          },
        ],
        counts: { evidence: 256, opportunities: 256 },
      }),
    },
    "capacity",
    { kind: "opportunity", view: "full" },
  )
  if ("error" in result)
    throw new Error("Blackboard full-page budget cannot hold the configured maximum entry")
  capacityChecked = true
}

export function blackboardIndexSnapshot(
  runStore: Pick<RunStore, "readBlackboardRecords">,
  challengeId: string,
): string {
  const encoded = JSON.stringify(readBlackboard(runStore, challengeId))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
  return (
    blackboardSnapshotPrompt(encoded) +
    "\nThis is a short evidence index, not the full board. Use blackboard_read kind=opportunity for leads; use view=full and ids for complete records, and afterId=nextAfterId for later pages."
  )
}
