import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vite-plus/test"
import type { SubagentRecord } from "../../src/collaboration/subagent-manager.ts"
import { RunStore } from "../../src/persistence/run-store.ts"
import {
  firstSubagentResultPage,
  subagentResultVersion,
} from "../../src/collaboration/subagent-report.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<RunStore> {
  const root = await mkdtemp(join(tmpdir(), "ctf-subagent-store-"))
  roots.push(root)
  return await RunStore.open(join(root, "runs.sqlite"))
}

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "worker-1",
    runId: "run-1",
    role: "pwn",
    displayName: "Pwn",
    description: "locate primitive",
    status: "running",
    background: true,
    prompt: "Find a stable leak",
    sessionPath: "F:/project/runs/run-1/subagents/worker-1/session.jsonl",
    containerCwd: "/workspace/subagents/worker-1",
    activeTool: "bash",
    turns: 2,
    toolUses: 3,
    totalTokens: 4096,
    inputTokens: 1_024,
    cacheReadTokens: 3_072,
    cacheWriteTokens: 128,
    createdAt: "2026-08-04T10:00:00.000Z",
    updatedAt: "2026-08-04T10:01:00.000Z",
    startedAt: "2026-08-04T10:00:01.000Z",
    ...overrides,
  }
}

describe("RunStore SubAgent persistence", () => {
  it("commits review count with execution, includes queued work in concurrency, and preserves count on resume (T39)", async () => {
    const store = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "pwn-1", workspace: "workspace", attempt: 1 })
    const goal = store.solveGoals.begin("pwn-1", true)
    const admission = { goalId: goal.id, maxPerGoal: 2, maxConcurrent: 1 }
    expect(() =>
      store.upsertSubagent(record({ purpose: "review", reviewId: `${goal.id}:worker-1` })),
    ).toThrow(expect.objectContaining({ code: "invalid_execution" }))
    const first = store.beginSubagentExecution(
      record({ purpose: "review", reviewId: `${goal.id}:worker-1`, executionId: "first" }),
      null,
      admission,
    )
    expect(store.solveGoals.get("pwn-1")?.reviewUsed).toBe(1)
    const secondInput = record({
      id: "worker-2",
      purpose: "review",
      reviewId: `${goal.id}:worker-2`,
      executionId: "second",
      status: "queued",
    })
    expect(() => store.beginSubagentExecution(secondInput, null, admission)).toThrow(
      expect.objectContaining({ code: "resource_limit" }),
    )
    expect(store.subagents("run-1")).toHaveLength(1)
    expect(store.solveGoals.get("pwn-1")?.reviewUsed).toBe(1)
    const firstDone = store.commitSubagentResult({ ...first, status: "completed" })
    const second = store.beginSubagentExecution(secondInput, null, admission)
    expect(store.solveGoals.get("pwn-1")?.reviewUsed).toBe(2)
    expect(() =>
      store.beginSubagentExecution(
        { ...firstDone, executionId: "first-resume", status: "running" },
        "first",
        admission,
      ),
    ).toThrow(expect.objectContaining({ code: "resource_limit" }))
    store.commitSubagentResult({ ...second, status: "completed" })
    const resumed = store.beginSubagentExecution(
      { ...firstDone, executionId: "first-resume", status: "running" },
      "first",
      admission,
    )
    expect(resumed.reviewId).toBe(first.reviewId)
    expect(store.solveGoals.get("pwn-1")?.reviewUsed).toBe(2)
    store.commitSubagentResult({ ...resumed, status: "completed" })
    store.updateRun("run-1", { status: "closed" })
    // A later Solver Run of the same goal is still allowed and sees the same count.
    expect(
      store.createRun({ id: "run-2", challengeId: "pwn-1", workspace: "workspace", attempt: 2 }).id,
    ).toBe("run-2")
    expect(() =>
      store.beginSubagentExecution(
        record({
          id: "worker-3",
          runId: "run-2",
          purpose: "review",
          reviewId: `${goal.id}:worker-3`,
          executionId: "third",
        }),
        null,
        admission,
      ),
    ).toThrow(expect.objectContaining({ code: "resource_limit" }))
    expect(store.solveGoals.get("pwn-1")?.reviewUsed).toBe(2)
    store.solveGoals.update(goal.id, { state: "stopped" })
    const nextGoal = store.solveGoals.begin("pwn-1", false)
    expect(nextGoal.id).not.toBe(goal.id)
    expect(nextGoal.reviewUsed).toBe(0)
    store.close()
  })

  it("restores review identity after restart and migrates old NULL classifications", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-review-ledger-"))
    roots.push(root)
    const path = join(root, "runs.sqlite")
    let store = await RunStore.open(path)
    store.createRun({ id: "run-1", challengeId: "rev-1", workspace: "workspace", attempt: 1 })
    const goal = store.solveGoals.begin("rev-1", true)
    const admission = { goalId: goal.id, maxPerGoal: 1, maxConcurrent: 1 }
    store.beginSubagentExecution(
      record({ purpose: "review", reviewId: `${goal.id}:worker-1`, executionId: "first" }),
      null,
      admission,
    )
    expect(store.dataCapabilities()["review-ledger"]).toBe(1)
    store.close()
    store = await RunStore.open(path)
    expect(store.solveGoals.get("rev-1")?.reviewUsed).toBe(1)
    expect(store.markInterruptedSubagents()).toMatchObject([
      { purpose: "review", reviewId: `${goal.id}:worker-1`, status: "interrupted" },
    ])
    const interrupted = store.subagents("run-1")[0]!
    const resumed = store.beginSubagentExecution(
      { ...interrupted, executionId: "second", status: "running" },
      "first",
      admission,
    )
    expect(resumed.reviewId).toBe(interrupted.reviewId)
    expect(store.solveGoals.get("rev-1")?.reviewUsed).toBe(1)
    store.close()

    const legacyPath = join(root, "legacy.sqlite")
    store = await RunStore.open(legacyPath)
    store.createRun({ id: "old-run", challengeId: "old", workspace: "workspace", attempt: 1 })
    store.upsertSubagent(record({ runId: "old-run" }))
    store.solveGoals.begin("old", true)
    store.close()
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec("DROP INDEX run_subagents_review_id")
    legacy.exec("ALTER TABLE run_subagents DROP COLUMN review_id")
    legacy.exec("ALTER TABLE run_subagents DROP COLUMN purpose")
    legacy.exec("ALTER TABLE solve_goals DROP COLUMN review_used")
    legacy.close()
    store = await RunStore.open(legacyPath)
    expect(store.solveGoals.get("old")?.reviewUsed).toBe(0)
    expect(store.subagents("old-run")[0]).not.toHaveProperty("purpose")
    expect(store.subagents("old-run")[0]).not.toHaveProperty("reviewId")
    store.close()
  })

  it("CAS isolates resumes and the first terminal writer wins (T13/T14)", async () => {
    const store = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "pwn-1", workspace: "workspace", attempt: 1 })
    const started = store.beginSubagentExecution(record({ executionId: "first" }), null)
    const completed = store.commitSubagentResult({
      ...started,
      status: "completed",
      result: "same",
      resultKind: "assistant_final",
    })
    expect(
      store.commitSubagentResult({ ...started, status: "cancelled", result: "loser" }),
    ).toEqual(completed)
    store.recordSubagentProgress({ ...started, turns: 500, result: "must not write" })
    expect(store.subagents("run-1")[0]).toEqual(completed)
    const resumed = store.beginSubagentExecution(
      { ...completed, executionId: "second", status: "running" },
      "first",
    )
    expect(resumed.result).toBeUndefined()
    expect(() => store.commitSubagentResult({ ...completed, result: "stale" })).toThrow(
      expect.objectContaining({ code: "stale_execution" }),
    )
    expect(() => store.recordSubagentProgress({ ...started, turns: 1000 })).toThrow(
      expect.objectContaining({ code: "stale_execution" }),
    )
    expect(() =>
      store.beginSubagentExecution({ ...resumed, executionId: "third" }, "first"),
    ).toThrow()
    expect(() => store.upsertSubagent({ ...resumed, executionId: undefined })).toThrow()
    const final = store.commitSubagentResult({
      ...resumed,
      status: "cancelled",
      result: "same",
      resultKind: "assistant_partial",
    })
    expect(subagentResultVersion(final)).not.toBe(subagentResultVersion(completed))
    expect(
      store.events("run-1").filter((event) => event.type === "subagent_result_committed"),
    ).toHaveLength(2)
    store.close()
  })

  it("rejects oversized reports without changing active state (T16)", async () => {
    const store = await storeFixture()
    store.createRun({ id: "run-1", challengeId: "pwn-1", workspace: "workspace", attempt: 1 })
    const started = store.beginSubagentExecution(record({ executionId: "one" }), null)
    expect(() =>
      store.commitSubagentResult({
        ...started,
        status: "completed",
        result: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).toThrow(expect.objectContaining({ code: "report_storage_limit" }))
    expect(store.subagents("run-1")[0]).toMatchObject({ status: "running" })
    store.close()
  })

  it("reopens long reports unchanged and serves bounded pages when feature is off (T40)", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-rollback-"))
    roots.push(root)
    const path = join(root, "runs.sqlite")
    let store = await RunStore.open(path)
    store.createRun({ id: "run-1", challengeId: "pwn-1", workspace: "workspace", attempt: 1 })
    const started = store.beginSubagentExecution(record({ executionId: "one" }), null)
    const text = "😀界".repeat(9000) + "tail"
    store.commitSubagentResult({
      ...started,
      status: "completed",
      result: text,
      resultKind: "assistant_final",
    })
    store.close()
    store = await RunStore.open(path)
    const saved = store.subagents("run-1")[0]!
    expect(saved.result).toBe(text)
    const page = firstSubagentResultPage(saved)
    expect(Array.from(page.result)).toHaveLength(8000)
    expect(page.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(96 * 1024)
    store.close()
  })

  it("以同一稳定 ID 更新完整 worker 生命周期快照", async () => {
    const store = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "pwn-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.upsertSubagent(record())
    store.upsertSubagent(
      record({
        status: "completed",
        result: "leak verified",
        activeTool: undefined,
        turns: 4,
        completedAt: "2026-08-04T10:02:00.000Z",
        updatedAt: "2026-08-04T10:02:00.000Z",
      }),
    )

    expect(store.subagents("run-1")).toEqual([
      expect.objectContaining({
        id: "worker-1",
        status: "completed",
        result: "leak verified",
        turns: 4,
        toolUses: 3,
        totalTokens: 4096,
        inputTokens: 1_024,
        cacheReadTokens: 3_072,
        cacheWriteTokens: 128,
      }),
    ])
    store.close()
  })

  it("启动恢复时只中断 queued/running worker", async () => {
    const store = await storeFixture()
    store.createRun({
      id: "run-1",
      challengeId: "rev-1",
      workspace: "workspace",
      attempt: 1,
    })
    store.upsertSubagent(record({ id: "running" }))
    store.upsertSubagent(record({ id: "queued", status: "queued" }))
    store.upsertSubagent(
      record({
        id: "done",
        status: "completed",
        completedAt: "2026-08-04T10:02:00.000Z",
      }),
    )

    expect(store.markInterruptedSubagents("service restarted")).toHaveLength(2)
    expect(store.subagents("run-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "running", status: "interrupted" }),
        expect.objectContaining({ id: "queued", status: "interrupted" }),
        expect.objectContaining({ id: "done", status: "completed" }),
      ]),
    )
    store.close()
  })
})
