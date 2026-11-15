import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { RunStore } from "../../src/persistence/run-store.ts"
import {
  persistAcceptedReceipt,
  recoverAcceptedReceipts,
} from "../../src/project/accepted-receipt.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "solve-goals-"))
  roots.push(root)
  const path = join(root, "runs.sqlite")
  const store = await RunStore.open(path)
  store.createRun({ id: "r", challengeId: "c", workspace: "workspace", attempt: 1 })
  return { root, path, store }
}

describe("T24/T28 durable solve goals", () => {
  it("migrates old queues idempotently and preserves explicit retry purpose and pause across reopen", async () => {
    const { path, store } = await fixture()
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("DROP TABLE scheduler_queue")
    legacy.exec(`CREATE TABLE scheduler_queue (
      challenge_id TEXT PRIMARY KEY, source TEXT NOT NULL, stage TEXT NOT NULL,
      lane TEXT NOT NULL, position INTEGER NOT NULL, manual_override INTEGER NOT NULL,
      enqueued_at TEXT NOT NULL, version INTEGER NOT NULL);
      INSERT INTO scheduler_queue VALUES ('old', 'manual', 'idle', 'normal', 1, 0, '2026-01-01', 1)`)
    legacy.close()
    const migrated = await RunStore.open(path)
    expect(migrated.schedulerQueue()[0]).toMatchObject({
      challengeId: "old",
      requiresAuto: true,
      resumeRunId: null,
    })
    const goal = migrated.solveGoals.begin("c", false)
    migrated.solveGoals.update(goal.id, {
      runId: "r",
      state: "paused",
      retryAt: "2030-01-01T00:00:00.000Z",
      failures: 9,
      reason: "configuration",
    })
    migrated.enqueueSchedulerChallenge({
      challengeId: "c",
      source: "retry",
      stage: "execution",
      lane: "normal",
      resumeRunId: "r",
      retryPrompt: "continue writeup",
      writeupRetry: true,
      requiresAuto: false,
    })
    migrated.setSchedulerMode("stopped")
    migrated.close()
    const reopened = await RunStore.open(path)
    expect(reopened.solveGoals.get("c")).toMatchObject({
      id: goal.id,
      runId: "r",
      state: "paused",
      failures: 9,
      reason: "configuration",
      requiresAuto: true,
    })
    expect(reopened.schedulerQueue("execution")[0]).toMatchObject({
      resumeRunId: "r",
      retryPrompt: "continue writeup",
      writeupRetry: true,
      requiresAuto: true,
    })
    reopened.close()
  })

  it("a stale execution cannot revive a stop or mutate a replacement goal; reset clears intent", async () => {
    const { store } = await fixture()
    const goal = store.solveGoals.begin("c", false)
    expect(store.dataCapabilities()).toMatchObject({ "continuous-solve-goals": 1 })
    store.solveGoals.update(goal.id, { runId: "r", state: "stopped" })
    store.solveGoals.update(goal.id, { state: "active" })
    expect(store.solveGoals.get("c")?.state).toBe("stopped")
    const next = store.solveGoals.begin("c", false)
    expect(next.id).not.toBe(goal.id)
    store.solveGoals.update(goal.id, { state: "accepted" })
    expect(store.solveGoals.get("c")?.state).toBe("active")
    store.createRun({ id: "other", challengeId: "different", workspace: "workspace", attempt: 1 })
    expect(() => store.solveGoals.update(next.id, { runId: "other" })).toThrow("another challenge")
    store.resetChallenge("c")
    expect(store.solveGoals.get("c")).toBeUndefined()
    store.close()
  })

  it("recovers actual acceptance with original identity/time, without inferring from platform solved state", async () => {
    const { root, path, store } = await fixture()
    store.solveGoals.begin("c", false)
    const directory = join(root, "runs", "r")
    await mkdir(directory, { recursive: true })
    const acceptedAt = "2026-11-15T08:01:02.003Z"
    await persistAcceptedReceipt(
      directory,
      { projectId: "p", challengeId: "c", runId: "r" },
      { status: "accepted", message: "Correct" },
      acceptedAt,
    )
    store.close() // Simulate process death after receipt fsync, before SQLite accepted write.
    const reopened = await RunStore.open(path)
    await recoverAcceptedReceipts(reopened, root, "p")
    expect(reopened.listRuns()[0]).toMatchObject({
      solveOutcome: "accepted",
      observedAcceptedAt: acceptedAt,
    })
    expect(reopened.solveGoals.get("c")?.state).toBe("accepted")
    await recoverAcceptedReceipts(reopened, root, "p")
    expect(
      reopened.events("r").filter((event) => event.type === "accepted_receipt_recovered"),
    ).toHaveLength(1)
    reopened.close()
  })

  it.each(["wrong-project", "wrong-run", "corruption", "missing"])(
    "rejects %s receipts instead of inventing accepted attribution",
    async (kind) => {
      const { root, store } = await fixture()
      const directory = join(root, "runs", "r")
      await mkdir(directory, { recursive: true })
      if (kind !== "missing") {
        await persistAcceptedReceipt(
          directory,
          {
            projectId: kind === "wrong-project" ? "q" : "p",
            challengeId: "c",
            runId: kind === "wrong-run" ? "other" : "r",
          },
          { status: "accepted", message: "Correct" },
          "2026-11-15T08:01:02.003Z",
        )
        if (kind === "corruption") {
          const path = join(directory, "accepted-receipt.json")
          await writeFile(path, (await readFile(path, "utf8")).replace("Correct", "Forged"))
        }
      }
      await recoverAcceptedReceipts(store, root, "p")
      expect(store.isSolved("c")).toBe(false)
      store.close()
    },
  )
})
