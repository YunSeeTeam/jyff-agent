import { describe, expect, it } from "vite-plus/test"
import {
  codePointLength,
  jsonByteLength,
  SUBAGENT_LIST_MAX_BYTES,
  SUBAGENT_RESULT_ENVELOPE_MAX_BYTES,
  type SubagentListPageDto,
  type SubagentResultPageDto,
  type ToolErrorEnvelope,
} from "../../src/contracts/index.ts"
import type { SubagentRecord } from "../../src/collaboration/subagent-manager.ts"
import {
  encodeSubagentCursor,
  SUBAGENT_MODEL_PREVIEW_CODE_POINTS,
  subagentListPage,
  subagentSnapshot,
  subagentSnapshotPrompt,
  subagentSummary,
} from "../../src/collaboration/subagent-projection.ts"
import {
  subagentResultPage,
  subagentResultVersion,
} from "../../src/collaboration/subagent-report.ts"

function record(index: number, overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  const createdAt = new Date(Date.UTC(2026, 10, 4, 0, 0, index)).toISOString()
  return {
    id: `agent-${String(index).padStart(3, "0")}`,
    runId: "run-1",
    role: "recon",
    displayName: "Recon",
    description: `task ${index}`,
    status: "completed",
    background: true,
    prompt: "p".repeat(32_000),
    sessionPath: "/host/runs/run-1/subagents/session.jsonl",
    containerCwd: "/workspace/subagents/x",
    result: `report ${index}`,
    turns: 1,
    toolUses: 2,
    totalTokens: 3,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }
}

function page(value: SubagentResultPageDto | ToolErrorEnvelope): SubagentResultPageDto {
  if ("error" in value) throw new Error(`unexpected error ${value.error.code}`)
  return value
}

function list(value: SubagentListPageDto | ToolErrorEnvelope): SubagentListPageDto {
  if ("error" in value) throw new Error(`unexpected error ${value.error.code}`)
  return value
}

// Every code point here costs the most JSON bytes it can: CJK (3), emoji (4 as one
// code point, 2 UTF-16 units), and control characters escaped as \u00XX (6).
const widest = "界😀\u0001"

describe("SubAgent report pages", () => {
  it("pages by code points, never splitting a surrogate pair, and reassembles exactly", () => {
    const text = `${widest.repeat(5_000)}TAIL-SENTINEL`
    const source = record(1, { result: text })
    const pages: string[] = []
    let current = page(subagentResultPage(source))
    pages.push(current.result)
    while (current.nextOffset !== undefined) {
      current = page(
        subagentResultPage(source, {
          offset: current.nextOffset,
          expectedResultVersion: current.resultVersion,
        }),
      )
      pages.push(current.result)
    }
    expect(pages.join("")).toBe(text)
    expect(pages.every((part) => codePointLength(part) <= 8_000)).toBe(true)
    expect(current).toMatchObject({ hasMore: false, totalLength: codePointLength(text) })
  })

  it("keeps a full page of the widest text within the envelope, cutting the error instead", () => {
    const first = page(
      subagentResultPage(record(1, { result: widest.repeat(4_000), error: widest.repeat(10_000) })),
    )
    expect(codePointLength(first.result)).toBe(8_000)
    expect(jsonByteLength(first)).toBeLessThanOrEqual(SUBAGENT_RESULT_ENVELOPE_MAX_BYTES)
    expect(codePointLength(first.errorMessage ?? "")).toBeLessThanOrEqual(2_000)
  })

  it("keeps the old 8000-unit prefix whole, so a candidate at its end stays visible", () => {
    const text = `${"a".repeat(7_980)}FLAG{late-in-prefix}`
    expect(text.length).toBe(8_000)
    expect(page(subagentResultPage(record(1, { result: text }))).result).toBe(text)
  })

  it("refuses a page asked for against another report, before checking anything else", () => {
    const first = page(subagentResultPage(record(1, { result: "x".repeat(9_000) })))
    const changed = subagentResultPage(record(1, { result: "" }), {
      offset: 8_000,
      expectedResultVersion: first.resultVersion,
    })
    expect(changed).toMatchObject({ error: { code: "result_changed", retryable: true } })
  })

  it("requires the version past offset 0 and rejects offsets past the end", () => {
    const source = record(1, { result: "abc" })
    const version = subagentResultVersion(source)
    expect(subagentResultPage(source, { offset: 1 })).toMatchObject({
      error: { code: "invalid_query" },
    })
    expect(
      page(subagentResultPage(source, { offset: 3, expectedResultVersion: version })),
    ).toMatchObject({ result: "", hasMore: false })
    expect(subagentResultPage(source, { offset: 4, expectedResultVersion: version })).toMatchObject(
      { error: { code: "invalid_offset" } },
    )
    expect(subagentResultPage(source, { limit: 8_001 })).toMatchObject({
      error: { code: "invalid_query" },
    })
  })

  it("says whether a missing report is still coming or will not come", () => {
    const running = page(subagentResultPage(record(1, { status: "running", result: undefined })))
    expect(running).toMatchObject({ state: "result_pending", result: "", totalLength: 0 })
    const failed = page(
      subagentResultPage(record(1, { status: "failed", result: undefined, error: "boom" })),
    )
    expect(failed).toMatchObject({ state: "result_unavailable", errorMessage: "boom" })
  })

  it("never carries the prompt or host paths", () => {
    const serialized = JSON.stringify(page(subagentResultPage(record(1))))
    expect(serialized).not.toContain("ppppp")
    expect(serialized).not.toContain("/host/")
    expect(serialized).not.toContain("/workspace/")
  })
})

describe("SubAgent summaries and lists", () => {
  it("summarizes without the prompt, paths, or full report", () => {
    const summary = subagentSummary(record(1, { result: "r".repeat(5_000) }), {
      previewCodePoints: SUBAGENT_MODEL_PREVIEW_CODE_POINTS,
    })
    expect(summary).toMatchObject({
      id: "agent-001",
      task: "task 1",
      hasMore: true,
      totalLength: 5_000,
    })
    expect(codePointLength(summary.resultPreview ?? "")).toBe(SUBAGENT_MODEL_PREVIEW_CODE_POINTS)
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain("ppppp")
    expect(serialized).not.toContain("/host/")
    expect(subagentSummary(record(1), { previewCodePoints: 0 }).resultPreview).toBeUndefined()
  })

  it("enumerates 100 SubAgents with the widest previews, each page within 16 KiB", () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      record(index, { result: widest.repeat(1_000), description: widest.repeat(200) }),
    )
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const current = list(
        subagentListPage("run-1", records, cursor ? { cursor, limit: 32 } : { limit: 32 }, {
          previewCodePoints: 1_200,
        }),
      )
      expect(jsonByteLength(current)).toBeLessThanOrEqual(SUBAGENT_LIST_MAX_BYTES)
      expect(current.items.length).toBeGreaterThan(0)
      seen.push(...current.items.map((item) => item.id))
      expect(current.omittedCount).toBe(100 - seen.length)
      cursor = current.nextCursor
      pages++
    } while (cursor && pages < 200)
    expect(seen).toEqual(records.map((item) => item.id))
  })

  it("orders by creation, not by update time, so a busy SubAgent is never skipped", () => {
    const records = [record(2), record(1, { updatedAt: "2099-01-01T00:00:00.000Z" }), record(3)]
    const first = list(subagentListPage("run-1", records, { limit: 1 }, { previewCodePoints: 0 }))
    expect(first.items.map((item) => item.id)).toEqual(["agent-001"])
    const rest = list(
      subagentListPage(
        "run-1",
        records,
        { cursor: first.nextCursor, limit: 32 },
        {
          previewCodePoints: 0,
        },
      ),
    )
    expect(rest.items.map((item) => item.id)).toEqual(["agent-002", "agent-003"])
    expect(rest.nextCursor).toBeUndefined()
  })

  it("rejects a cursor from another Run or one that was tampered with", () => {
    const foreign = encodeSubagentCursor("run-2", record(1, { runId: "run-2" }))
    for (const cursor of [foreign, "not base64!", Buffer.from("{}").toString("base64url")]) {
      expect(
        subagentListPage("run-1", [record(1)], { cursor }, { previewCodePoints: 0 }),
      ).toMatchObject({ error: { code: "invalid_query" } })
    }
    expect(
      subagentListPage("run-1", [record(1)], { limit: 33 }, { previewCodePoints: 0 }),
    ).toMatchObject({
      error: { code: "invalid_query" },
    })
  })

  it("puts active SubAgents first in the recovery snapshot and counts the rest", () => {
    const records = [
      ...Array.from({ length: 40 }, (_, index) => record(index, { result: widest.repeat(400) })),
      record(99, { status: "running", result: undefined }),
    ]
    const snapshot = subagentSnapshot("run-1", records, {
      previewCodePoints: SUBAGENT_MODEL_PREVIEW_CODE_POINTS,
    })
    expect(snapshot.items[0]?.id).toBe("agent-099")
    expect(snapshot.items[1]?.id).toBe("agent-039")
    expect(snapshot.nextCursor).toBeUndefined()
    expect(snapshot.omittedCount).toBe(41 - snapshot.items.length)
    expect(jsonByteLength(snapshot)).toBeLessThanOrEqual(SUBAGENT_LIST_MAX_BYTES)
    expect(subagentSnapshotPrompt(snapshot)).toContain(
      `${snapshot.omittedCount} more SubAgents are not shown here`,
    )
  })
})
