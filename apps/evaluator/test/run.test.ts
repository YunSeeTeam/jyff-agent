import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { RunStore } from "@ctf-agent/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import type { ApiResult, BackendApi, BackendExit, BackendLauncher } from "../src/backend.ts"
import type { EvaluationConfig } from "../src/config.ts"
import { type EvaluationDeps, runEvaluation, sampleOrder } from "../src/run.ts"
import { removeTempDirs, tempDir, writeTemplateRoot } from "./helpers.ts"

const MINUTE = 60_000
const PROJECT = "root-project"

beforeEach(() => {
  // RunStore stamps events with new Date(); fake only Date so the simulated
  // backend and the evaluator share one controllable clock.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-02T08:00:00.000Z"))
})
afterEach(async () => {
  vi.useRealTimers()
  await removeTempDirs()
})

interface Scenario {
  dispatch?: ApiResult
  exitBeforeReady?: boolean
  /** Steps relative to the accepted dispatch. */
  timeline?: Array<{ afterMs: number; apply: (store: RunStore) => void }>
  onCancel?: (store: RunStore) => void
}

interface Harness {
  config: EvaluationConfig
  deps: EvaluationDeps
  calls: { dispatch: number; cancel: number; containersListed: string[][]; removed: string[][] }
}

async function harness(
  scenarios: Scenario[],
  overrides: Partial<EvaluationConfig> = {},
  containers: string[] = [],
): Promise<Harness> {
  const template = await tempDir("template")
  await writeTemplateRoot(template, PROJECT)
  const output = join(await tempDir("output"), "group-a")
  const config: EvaluationConfig = {
    group: "A-original",
    templateRoot: template,
    outputDir: output,
    projectId: PROJECT,
    challenges: [{ id: "web-1" }],
    repeats: 1,
    wallClockMs: 60 * MINUTE,
    postAcceptGraceMs: 5 * MINUTE,
    cancelGraceMs: MINUTE,
    readyTimeoutMs: 2 * MINUTE,
    pollIntervalMs: 10_000,
    idleSettleMs: MINUTE,
    backend: {
      cwd: template,
      command: ["node"],
      host: "127.0.0.1",
      port: 3_900,
      extraArgs: [],
    },
    pricing: {},
    removeLeftoverContainers: true,
    ...overrides,
  }
  const calls: Harness["calls"] = { dispatch: 0, cancel: 0, containersListed: [], removed: [] }
  let store: RunStore | undefined
  let scenario: Scenario = {}
  let dispatchedAt: number | undefined
  let applied = 0
  let resolveExit: ((exit: BackendExit) => void) | undefined

  const advance = () => {
    const timeline = scenario.timeline ?? []
    while (store && dispatchedAt !== undefined && applied < timeline.length) {
      const step = timeline[applied]
      if (!step || Date.now() < dispatchedAt + step.afterMs) break
      step.apply(store)
      applied += 1
    }
  }

  const launcher: BackendLauncher = {
    async start({ root }) {
      scenario = scenarios.shift() ?? {}
      dispatchedAt = undefined
      applied = 0
      const exited = new Promise<BackendExit>((resolve) => {
        resolveExit = resolve
      })
      if (scenario.exitBeforeReady) resolveExit?.({ code: 1, signal: null })
      else store = await RunStore.open(join(root, ".ctf-agent", "runs.sqlite"))
      return {
        baseUrl: "http://fake",
        exited,
        async stop() {
          store?.close()
          store = undefined
          resolveExit?.({ code: 0, signal: null })
          return exited
        },
      }
    },
  }

  const api: BackendApi = {
    async health() {
      return scenario.exitBeforeReady
        ? undefined
        : { controlPlanePhase: "ready", authenticationEnabled: false, authenticated: false }
    },
    async login() {
      return { ok: true }
    },
    async dispatch() {
      calls.dispatch += 1
      const result = scenario.dispatch ?? { ok: true }
      if (result.ok) {
        dispatchedAt = Date.now()
        store?.enqueueSchedulerChallenge({ challengeId: "web-1", source: "manual" })
        advance()
      }
      return result
    },
    async cancel() {
      calls.cancel += 1
      if (store) scenario.onCancel?.(store)
      return { ok: true }
    },
  }

  const deps: EvaluationDeps = {
    launcher,
    connect: () => api,
    now: () => Date.now(),
    async sleep(ms) {
      vi.setSystemTime(Date.now() + ms)
      advance()
    },
    async runCommand() {
      return { code: 0, output: "" }
    },
    async listRunContainers(runIds) {
      calls.containersListed.push(runIds)
      return containers
    },
    async removeContainers(ids) {
      calls.removed.push(ids)
    },
    async environment() {
      return {
        evaluatorNode: "test",
        platform: "test",
        backendGit: { commit: "5ae3b9d", dirty: false },
        solverImageId: null,
      }
    },
    log: () => {},
  }
  return { config, deps, calls }
}

function startRun(id: string, attempt = 1) {
  return (store: RunStore) => {
    store.removeSchedulerChallenge("web-1")
    store.createRun({ id, challengeId: "web-1", workspace: "/w", attempt })
    store.updateRun(id, { status: "running", startedAt: new Date().toISOString() })
  }
}

function accept(id: string) {
  return (store: RunStore) => {
    store.appendEvent(id, "flag_submitted", { status: "accepted", message: "Correct" })
    store.updateRun(id, { status: "writing_writeup" })
  }
}

describe("runEvaluation", () => {
  it("records an on-time acceptance and stops once writeup ends", async () => {
    const { config, deps, calls } = await harness([
      {
        timeline: [
          { afterMs: 0, apply: startRun("run-1") },
          { afterMs: 20 * MINUTE, apply: accept("run-1") },
          {
            afterMs: 22 * MINUTE,
            apply: (store) => store.updateRun("run-1", { status: "solved" }),
          },
        ],
      },
    ])

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "accepted", stopReason: "accepted", cancel: null })
    expect(result?.timeToAcceptMs).toBe(20 * MINUTE)
    expect(result?.observation?.firstAcceptedAt).not.toBeNull()
    expect(calls.cancel).toBe(0)
    const lines = (await readFile(join(config.outputDir, "results.jsonl"), "utf8"))
      .trim()
      .split("\n")
    expect(lines).toHaveLength(1)
    const manifest = JSON.parse(await readFile(join(config.outputDir, "manifest.json"), "utf8"))
    expect(manifest).toMatchObject({
      group: "A-original",
      template: { files: 3, sensitiveFilesPresent: [".ctf-agent/secrets.json"] },
    })
  })

  it("cancels at the strict deadline and counts the sample as not accepted", async () => {
    const { config, deps, calls } = await harness([
      {
        timeline: [{ afterMs: 0, apply: startRun("run-1") }],
        onCancel: (store) => store.updateRun("run-1", { status: "cancelled" }),
      },
    ])

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "not_accepted", stopReason: "deadline" })
    expect(calls.cancel).toBe(1)
    expect(Date.parse(result?.cancel?.requestedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(result?.deadlineAt ?? ""),
    )
  })

  it("does not stop between a failed attempt and its in-memory retry", async () => {
    const { config, deps } = await harness([
      {
        timeline: [
          { afterMs: 0, apply: startRun("run-1") },
          {
            afterMs: 10 * MINUTE,
            apply: (store) => store.updateRun("run-1", { status: "failed" }),
          },
          { afterMs: 10 * MINUTE + 30_000, apply: startRun("run-2", 2) },
          { afterMs: 25 * MINUTE, apply: accept("run-2") },
          {
            afterMs: 26 * MINUTE,
            apply: (store) => store.updateRun("run-2", { status: "solved" }),
          },
        ],
      },
    ])

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "accepted", stopReason: "accepted" })
    expect(result?.observation?.runs.map((run) => run.id)).toEqual(["run-1", "run-2"])
  })

  it("finishes after the idle settle period when no retry follows", async () => {
    const { config, deps } = await harness([
      {
        timeline: [
          { afterMs: 0, apply: startRun("run-1") },
          {
            afterMs: 10 * MINUTE,
            apply: (store) => store.updateRun("run-1", { status: "failed" }),
          },
        ],
      },
    ])

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "not_accepted", stopReason: "finished" })
    const stoppedAfter =
      Date.parse(result?.stoppedAt ?? "") - Date.parse(result?.dispatchedAt ?? "")
    expect(stoppedAfter).toBeGreaterThanOrEqual(11 * MINUTE)
    expect(stoppedAfter).toBeLessThan(12 * MINUTE)
  })

  it("rejects a sample whose platform already reports the challenge solved", async () => {
    const { config, deps, calls } = await harness([
      { dispatch: { ok: false, status: 409, code: "already_solved", message: "该题已经解出" } },
    ])

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "isolation_failed", dispatchedAt: null })
    expect(result?.harnessErrors).toEqual([
      { step: "dispatch", code: "already_solved", message: "该题已经解出" },
    ])
    expect(calls.dispatch).toBe(1)
  })

  it("records a backend that exits before it is ready", async () => {
    const { config, deps } = await harness([{ exitBeforeReady: true }])

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "harness_error", stopReason: "backend_exited" })
    expect(result?.backendExit).toEqual({ code: 1, signal: null })
  })

  it("stops before starting a backend when the platform reset fails", async () => {
    const { config, deps } = await harness([], { resetCommand: ["reset-platform"] })
    const start = vi.spyOn(deps.launcher, "start")
    deps.runCommand = async () => ({ code: 2, output: "reset failed" })

    const [result] = await runEvaluation(config, deps)

    expect(result).toMatchObject({ outcome: "harness_error" })
    expect(result?.harnessErrors[0]).toMatchObject({ step: "reset", code: "reset_failed" })
    expect(start).not.toHaveBeenCalled()
  })

  it("reports and removes containers left behind by the sample's runs", async () => {
    const { config, deps, calls } = await harness(
      [
        {
          timeline: [
            { afterMs: 0, apply: startRun("run-1") },
            { afterMs: MINUTE, apply: (store) => store.updateRun("run-1", { status: "failed" }) },
          ],
        },
      ],
      {},
      ["container-1"],
    )

    const [result] = await runEvaluation(config, deps)

    expect(calls.containersListed).toEqual([["run-1"]])
    expect(calls.removed).toEqual([["container-1"]])
    expect(result?.leftoverContainers).toEqual({ found: 1, removed: 1 })
  })

  it("refuses to append to an output directory that already has results", async () => {
    const { config, deps } = await harness([
      {
        timeline: [
          { afterMs: 0, apply: startRun("run-1") },
          { afterMs: 0, apply: accept("run-1") },
        ],
      },
    ])
    await runEvaluation(config, deps)

    await expect(runEvaluation(config, deps)).rejects.toThrow(/已有结果/)
  })
})

describe("sampleOrder", () => {
  it("interleaves repeats so each round starts from a different challenge", () => {
    const plan = sampleOrder({
      group: "A original",
      repeats: 2,
      challenges: [{ id: "a" }, { id: "b" }, { id: "c" }],
    })
    expect(plan.map((item) => `${item.repeat}:${item.challenge.id}`)).toEqual([
      "1:a",
      "1:b",
      "1:c",
      "2:b",
      "2:c",
      "2:a",
    ])
    expect(plan[0]?.sampleId).toBe("A_original-r1-001-a")
  })
})
