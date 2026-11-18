import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { expect, it } from "vite-plus/test"
import { RunStore } from "../../src/persistence/run-store.ts"

it("reserves process keys and retained Run log capacity across recovery", async () => {
  const scratch = resolve(process.cwd(), "../outputs/tmp")
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "process-store-"))
  const runId = randomUUID()
  const path = join(root, "runs.sqlite")
  let store: RunStore | undefined
  try {
    store = await RunStore.open(path)
    store.createRun({ id: runId, challengeId: "offline", workspace: root, attempt: 1 })
    const sessions = store.localProcesses
    const reserve = (key: string) =>
      sessions.reserve({
        runId,
        owner: "solver",
        requestKey: key,
        fingerprint: key,
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 300000).toISOString(),
      })
    const a = reserve("a")
    expect(a.created).toBe(true)
    expect(reserve("a").receipt.id).toBe(a.receipt.id)
    expect(() =>
      sessions.reserve({
        runId,
        owner: "solver",
        requestKey: "a",
        fingerprint: "changed",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 300000).toISOString(),
      }),
    ).toThrow("request_key_conflict")
    const b = reserve("b")
    const c = reserve("c")
    const d = reserve("d")
    expect(() => reserve("e")).toThrow("local_process_quota")
    sessions.finish(runId, a.receipt.id, {
      state: "exited",
      exitCode: 0,
      stopReason: null,
      stdoutBytes: 64 * 1024 * 1024,
      stderrBytes: 0,
      cleanupState: "confirmed",
    })
    expect(() => reserve("e")).toThrow("local_process_quota")
    sessions.finish(runId, b.receipt.id, {
      state: "exited",
      exitCode: 1,
      stopReason: null,
      stdoutBytes: 10,
      stderrBytes: 0,
      cleanupState: "confirmed",
    })
    expect(() => reserve("e")).toThrow("local_process_quota")
    sessions.finish(runId, c.receipt.id, {
      state: "exited",
      exitCode: 0,
      stopReason: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      cleanupState: "confirmed",
    })
    const e = reserve("e")
    expect(e.receipt.state).toBe("starting")
    store.close()
    store = await RunStore.open(path)
    store.localProcesses.recover()
    expect(store.localProcesses.find(runId, a.receipt.id, "solver")).toMatchObject({
      state: "exited",
      exitCode: 0,
    })
    for (const id of [d.receipt.id, e.receipt.id]) {
      expect(store.localProcesses.find(runId, id, "solver")).toMatchObject({
        state: "interrupted",
        exitCode: null,
        cleanupState: "unknown",
      })
    }
    store.localProcesses.confirmRunCleanup(runId)
    expect(store.localProcesses.find(runId, e.receipt.id, "solver")?.cleanupState).toBe("confirmed")
  } finally {
    store?.close()
    if (resolve(root).startsWith(`${resolve(scratch)}${sep}`))
      await rm(root, { recursive: true, force: true })
  }
})
