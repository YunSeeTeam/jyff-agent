import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { RunStore } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { collectSample, readRunState } from "../src/collect.ts"
import { assistant, removeTempDirs, tempDir, usage, user, writeSession } from "./helpers.ts"

const stores: RunStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await removeTempDirs()
})

async function openStore(stateDirectory: string): Promise<RunStore> {
  const store = await RunStore.open(join(stateDirectory, "runs.sqlite"))
  stores.push(store)
  return store
}

const PRICING = { "openai/gpt-x": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } }

describe("collectSample", () => {
  it("observes submissions, run status and session cost for one challenge only", async () => {
    const state = await tempDir("collect")
    const store = await openStore(state)
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "/w", attempt: 1 })
    store.updateRun("run-1", { status: "running", startedAt: new Date().toISOString() })
    store.appendEvent("run-1", "flag_submitted", { status: "incorrect", message: "wrong flag" })
    const accepted = store.appendEvent("run-1", "flag_submitted", {
      status: "accepted",
      message: "Correct",
    })
    // Baseline defect A01: a writeup failure leaves the Run failed after acceptance.
    store.updateRun("run-1", { status: "failed", error: "writeup validation failed" })
    store.createRun({ id: "run-other", challengeId: "pwn-2", workspace: "/w2", attempt: 1 })
    store.appendEvent("run-other", "flag_submitted", { status: "accepted", message: "other" })
    store.recordModelTokenUsage({
      source: "solver",
      provider: "openai",
      model: "gpt-x",
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 500,
    })

    await writeSession(join(state, "runs", "run-1", "session.jsonl"), async (session) => {
      session.appendModelChange("openai", "gpt-x")
      session.appendMessage(user("solve web-1"))
      session.appendMessage(
        assistant("analysis", {
          provider: "openai",
          model: "gpt-x",
          usage: usage({ input: 1_000, output: 200, cacheRead: 500, costTotal: 99 }),
        }),
      )
      // Compaction usage carries no model; it belongs to the active model.
      session.appendCompaction(
        "summary",
        null,
        1_000,
        undefined,
        false,
        usage({ input: 300, output: 50 }),
      )
    })
    await writeSession(
      join(state, "runs", "run-1", "subagents", "sa-1", "session.jsonl"),
      async (session) => {
        session.appendMessage(
          assistant("subagent report", {
            provider: "anthropic",
            model: "claude-x",
            usage: usage({ input: 400, output: 100, costTotal: 0.002 }),
          }),
        )
      },
    )
    await writeSession(
      join(state, "challenges", "key", "workspace", "tldr", "session.jsonl"),
      async (session) => {
        session.appendMessage(
          assistant("tldr", {
            provider: "local",
            model: "free",
            usage: usage({ input: 50, output: 10 }),
          }),
        )
      },
    )
    // Agents can write arbitrary .jsonl files into the shared workspace.
    await mkdir(join(state, "challenges", "key", "workspace", "data"), { recursive: true })
    await writeFile(
      join(state, "challenges", "key", "workspace", "data", "session.jsonl"),
      `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 9e9 } } })}\n`,
    )

    const observation = await collectSample(state, "web-1", PRICING)

    expect(observation.runs.map((run) => [run.id, run.status])).toEqual([["run-1", "failed"]])
    expect(observation.submissions.map((item) => item.status)).toEqual(["incorrect", "accepted"])
    expect(observation.firstAcceptedAt).toBe(accepted.createdAt)
    expect(observation.rejectedSubmissions).toBe(1)
    expect(observation.acceptedWithoutSolvedRun).toBe(true)
    expect(observation.activeRunIds).toEqual([])

    // gpt-x by table: (1000*2 + 200*8 + 500*0.5) + (300*2 + 50*8) micros.
    expect(observation.usageByModel["openai/gpt-x"]).toMatchObject({
      requests: 2,
      costMicros: 3_850 + 1_000,
      tablePricedRequests: 2,
    })
    expect(observation.usageByModel["anthropic/claude-x"]).toMatchObject({
      costMicros: 2_000,
      sessionPricedRequests: 1,
    })
    expect(observation.usageByModel["local/free"]).toMatchObject({
      costMicros: 0,
      unpricedRequests: 1,
    })
    expect(observation.usage).toMatchObject({
      requests: 4,
      inputTokens: 1_750,
      costMicros: 6_850,
      unpricedRequests: 1,
    })
    expect(observation.usageByKind.subagent.requests).toBe(1)
    expect(observation.usageByKind.tldr.requests).toBe(1)
    expect(observation.sessions.map((item) => item.path)).toEqual([
      "runs/run-1/session.jsonl",
      "runs/run-1/subagents/sa-1/session.jsonl",
      "challenges/key/workspace/tldr/session.jsonl",
    ])
    expect(observation.tokenUsageTable).toMatchObject({ rows: 1, inputTokens: 1_000 })
  })

  it("reads a live store that the backend still holds open", async () => {
    const state = await tempDir("live")
    const store = await openStore(state)
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "/w", attempt: 1 })
    store.updateRun("run-1", { status: "running" })
    store.enqueueSchedulerChallenge({ challengeId: "web-1", source: "manual" })

    const live = await readRunState(state, "web-1")
    expect(live.activeRunIds).toEqual(["run-1"])
    expect(live.queued).toMatchObject({ stage: "execution", lane: "normal" })

    store.removeSchedulerChallenge("web-1")
    store.updateRun("run-1", { status: "cancelled" })
    const after = await readRunState(state, "web-1")
    expect(after.activeRunIds).toEqual([])
    expect(after.queued).toBeNull()
  })

  it("does not flag a writeup failure as lost success when the outcome was recorded", async () => {
    const state = await tempDir("outcome")
    const store = await openStore(state)
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "/w", attempt: 1 })
    store.appendEvent("run-1", "flag_submitted", { status: "accepted", message: "Correct" })
    store.recordSolveOutcome({ runId: "run-1", outcome: "accepted" })
    store.updateRun("run-1", { status: "failed", writeupStatus: "failed" })

    const observation = await collectSample(state, "web-1", {})

    expect(observation.runs[0]).toMatchObject({
      status: "failed",
      solveOutcome: "accepted",
      writeupStatus: "failed",
    })
    expect(observation.acceptedWithoutSolvedRun).toBe(false)
  })

  it("reads stores from builds that predate the outcome columns", async () => {
    const state = await tempDir("legacy-columns")
    const store = await openStore(state)
    store.createRun({ id: "run-1", challengeId: "web-1", workspace: "/w", attempt: 1 })
    store.appendEvent("run-1", "flag_submitted", { status: "accepted", message: "Correct" })
    store.updateRun("run-1", { status: "failed" })
    stores.splice(stores.indexOf(store), 1)
    store.close()
    const legacy = new DatabaseSync(join(state, "runs.sqlite"))
    for (const column of [
      "solve_outcome",
      "observed_accepted_at",
      "platform_accepted_at",
      "writeup_status",
    ]) {
      legacy.exec(`ALTER TABLE runs DROP COLUMN ${column}`)
    }
    legacy.close()

    const observation = await collectSample(state, "web-1", {})

    expect(observation.runs[0]).toMatchObject({ solveOutcome: null, writeupStatus: null })
    expect(observation.acceptedWithoutSolvedRun).toBe(true)
  })

  it("counts a request that reported no usage as unknown rather than free", async () => {
    const state = await tempDir("no-usage")
    await writeSession(join(state, "runs", "run-1", "session.jsonl"), async (session) => {
      session.appendMessage(
        assistant("streamed without usage", {
          provider: "openai",
          model: "gpt-x",
          usage: usage({}),
        }),
      )
    })

    const observation = await collectSample(state, "web-1", PRICING)

    expect(observation.usage).toMatchObject({
      requests: 1,
      costMicros: 0,
      tablePricedRequests: 0,
      unknownUsageRequests: 1,
    })
  })

  it("reports an empty observation when the backend never created a store", async () => {
    const state = await tempDir("no-store")
    const observation = await collectSample(state, "web-1", {})
    expect(observation.databaseFound).toBe(false)
    expect(observation.runs).toEqual([])
    expect(observation.usage.requests).toBe(0)
  })
})
