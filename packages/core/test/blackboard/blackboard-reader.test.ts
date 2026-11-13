import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { RunStore } from "../../src/persistence/run-store.ts"
import {
  blackboardReadToolResult,
  createBlackboardReadTool,
  readBlackboard,
} from "../../src/collaboration/blackboard-reader.ts"
import type { BlackboardReadInput, BlackboardReadResult } from "../../src/contracts/index.ts"

const stores: RunStore[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
})
async function fixture() {
  const store = await RunStore.open(":memory:")
  stores.push(store)
  for (const [id, challengeId] of [
    ["r1", "c1"],
    ["r2", "c1"],
    ["r3", "c2"],
  ]) {
    store.createRun({
      id: id!,
      challengeId: challengeId!,
      workspace: "/workspace",
      attempt: id === "r2" ? 2 : 1,
    })
    store.updateRun(id!, { status: "failed" })
  }
  return store
}
function page(value: ReturnType<typeof readBlackboard>): BlackboardReadResult {
  if ("error" in value) throw new Error(JSON.stringify(value))
  return value
}
function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value))
}

describe("blackboard reader v2", () => {
  it("enumerates 256 maximum records of both kinds with bounded continuous pages (T07/T09)", async () => {
    const store = await fixture()
    const description = "观测🧪\u0000".repeat(800)
    const evidenceIds: number[] = []
    const opportunityIds: number[] = []
    for (let i = 0; i < 256; i++) {
      const evidence = store.recordEvidence("c1", "r1", description)
      evidenceIds.push(evidence.id)
      opportunityIds.push(store.recordOpportunity("c1", "r1", description, [evidence.id]).id)
    }
    const wholeBoard = vi.spyOn(store, "getBlackboardSummary").mockImplementation(() => {
      throw new Error("must use scoped SQL")
    })
    for (const kind of ["evidence", "opportunity"] as const)
      for (const view of ["index", "full"] as const) {
        const ids: number[] = []
        let afterId = 0
        for (let requests = 0; requests < 257; requests++) {
          const result = page(readBlackboard(store, "c1", { kind, view, limit: 16, afterId }))
          expect(bytes(blackboardReadToolResult(result))).toBeLessThanOrEqual(
            view === "index" ? 8192 : 65536,
          )
          expect(result.entries.length).toBeGreaterThan(0)
          ids.push(...result.entries.map((entry) => entry.id))
          if (!result.hasMore) {
            expect(result.nextAfterId).toBeUndefined()
            break
          }
          expect(result.nextAfterId).toBeGreaterThan(afterId)
          afterId = result.nextAfterId!
        }
        expect(ids).toEqual(kind === "evidence" ? evidenceIds : opportunityIds)
      }
    expect(wholeBoard).not.toHaveBeenCalled()
  })

  it("isolates IDs, preserves request order, deduplicates and validates before defaults (T08)", async () => {
    const store = await fixture()
    const a = store.recordEvidence("c1", "r1", "a")
    const b = store.recordEvidence("c1", "r1", "b")
    const foreign = store.recordEvidence("c2", "r3", "secret")
    const result = page(readBlackboard(store, "c1", { ids: [b.id, foreign.id, a.id, b.id, 999] }))
    expect(result.entries.map((entry) => entry.id)).toEqual([b.id, a.id])
    expect(result.missingIds).toEqual([foreign.id, 999])
    expect(JSON.stringify(result)).not.toContain("secret")
    for (const input of [
      { ids: [a.id], limit: 8 },
      { ids: [a.id], afterId: 0 },
      { ids: [] },
      { ids: [0] },
      { ids: [Number.MAX_SAFE_INTEGER + 1] },
      { limit: 17 },
      { afterId: -1 },
      { kind: "all" },
      { challengeId: "c2" },
      { view: "raw" },
      { ids: Array(17).fill(1) },
    ])
      expect(readBlackboard(store, "c1", input as BlackboardReadInput)).toMatchObject({
        error: { code: "invalid_query" },
      })
    expect(page(readBlackboard(store, "c1")).view).toBe("index")
  })

  it("retains full legal control-character records and all 32 sources; omitted IDs remain readable (T09)", async () => {
    const store = await fixture()
    const sources = Array.from(
      { length: 32 },
      (_, i) => store.recordEvidence("c1", "r1", `s${i}`).id,
    )
    const ids = Array.from(
      { length: 5 },
      () => store.recordOpportunity("c1", "r1", "x" + "\u0001".repeat(3999), sources).id,
    )
    let remaining = ids
    const found: number[] = []
    while (remaining.length) {
      const result = page(
        readBlackboard(store, "c1", { kind: "opportunity", view: "full", ids: remaining }),
      )
      expect(bytes(blackboardReadToolResult(result))).toBeLessThanOrEqual(65536)
      expect(result.entries[0]).toMatchObject({
        description: "x" + "\u0001".repeat(3999),
        sourceEvidenceIds: sources,
      })
      found.push(...result.entries.map((entry) => entry.id))
      remaining = result.omittedIds
      expect(result.hasMore).toBe(remaining.length > 0)
    }
    expect(found).toEqual(ids)
  })

  it("tracks content changes/deletion and retains true creator provenance across Runs (T10)", async () => {
    const store = await fixture()
    const record = store.recordEvidence("c1", "r1", "old")
    const before = page(readBlackboard(store, "c1", { ids: [record.id] })).entries[0]!
    expect(before).toMatchObject({ creatorRunId: "r1", createdAt: record.createdAt })
    store.updateEvidence("c1", record.id, "new")
    const after = page(readBlackboard(store, "c1", { ids: [record.id] })).entries[0]!
    expect(after.contentHash).not.toBe(before.contentHash)
    expect(after.creatorRunId).toBe("r1")
    expect(page(readBlackboard(store, "c1", { ids: [record.id] })).entries[0]!.contentHash).toBe(
      after.contentHash,
    )
    const opp = store.recordOpportunity("c1", "r2", "lead", [record.id])
    const oldHash = page(readBlackboard(store, "c1", { kind: "opportunity", ids: [opp.id] }))
      .entries[0]!.contentHash
    store.concludeOpportunity("c1", opp.id, "negative under these conditions", "r2", "dead_end")
    expect(
      page(readBlackboard(store, "c1", { kind: "opportunity", ids: [opp.id] })).entries[0]!
        .contentHash,
    ).not.toBe(oldHash)
    store.deleteOpportunity("c1", opp.id)
    store.deleteEvidence("c1", record.id)
    expect(page(readBlackboard(store, "c1", { ids: [record.id] })).missingIds).toEqual([record.id])
  })

  it("returns a diagnostic for an oversized legacy entry without an empty-page loop", () => {
    const store = {
      readBlackboardRecords: () => ({
        records: [
          {
            id: 1,
            challengeId: "c1",
            runId: "r1",
            createdAt: "now",
            description: "x".repeat(70000),
          },
        ],
        counts: { evidence: 1, opportunities: 0 },
      }),
    }
    expect(readBlackboard(store, "c1", { view: "full" })).toMatchObject({
      error: { code: "entry_too_large", details: { id: 1 } },
    })
  })

  it("tool details contain navigation only and invalid queries set isError", async () => {
    const store = await fixture()
    store.recordEvidence("c1", "r1", "private observation")
    const tool = createBlackboardReadTool(store, "c1")
    const result = await tool.execute("read", {})
    expect(JSON.stringify(result.details)).not.toContain("private observation")
    expect(JSON.stringify(result.content)).toContain("private observation")
    expect(await tool.execute("bad", { ids: [1], afterId: 0 })).toMatchObject({ isError: true })
  })
})
