import { lstat, mkdtemp, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { RunStore } from "@ctf-agent/core"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  assertDataCompatible,
  requiredDataCapabilities,
} from "../../updater/src/data-compatibility.ts"
import { SourceUpdateWorker } from "../../updater/src/main.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "data-compatibility-"))
  roots.push(root)
  const candidate = join(root, "candidate")
  await mkdir(candidate)
  const state = join(root, ".ctf-agent")
  await mkdir(state)
  return { root, candidate, state }
}
function database(path: string, capabilities: Record<string, number>) {
  const db = new DatabaseSync(join(path, "runs.sqlite"))
  db.exec(
    "CREATE TABLE runtime_data_capabilities (name TEXT PRIMARY KEY, version INTEGER NOT NULL)",
  )
  const statement = db.prepare("INSERT INTO runtime_data_capabilities VALUES (?, ?)")
  for (const [name, version] of Object.entries(capabilities)) statement.run(name, version)
  db.close()
}
describe("updater minimum data reader capability (T40)", () => {
  it("ships a reader declaration compatible with its own persisted solve goals and blocks older readers", async () => {
    const { root, candidate, state } = await fixture()
    const store = await RunStore.open(join(state, "runs.sqlite"))
    try {
      store.solveGoals.begin("local-challenge", false)
      store.enqueueSchedulerChallenge({ challengeId: "local-challenge", source: "manual" })
    } finally {
      store.close()
    }
    const currentBuild = fileURLToPath(new URL("../../../", import.meta.url))
    await expect(assertDataCompatible(currentBuild, root)).resolves.toBeUndefined()
    await writeFile(
      join(candidate, "runtime-data-capabilities.json"),
      JSON.stringify({
        schemaVersion: 1,
        read: { "accepted-fact": 1, "bounded-subagent-reports": 1 },
      }),
    )
    await expect(assertDataCompatible(candidate, root)).rejects.toThrow("continuous-solve-goals@1")
  })

  it("does not lose capability names inherited from Object.prototype", async () => {
    const { root, candidate, state } = await fixture()
    database(state, JSON.parse('{"__proto__":1}') as Record<string, number>)
    expect(Object.keys(await requiredDataCapabilities(root))).toEqual(["__proto__"])
    await expect(assertDataCompatible(candidate, root)).rejects.toThrow("__proto__@1")
  })

  it("rejects a stage 4 reader after evidence or pending cleanup data is written", async () => {
    const { root, candidate, state } = await fixture()
    const store = await RunStore.open(join(state, "runs.sqlite"))
    const old = store.dataCapabilities()
    try {
      store.createRun({ id: "r", challengeId: "c", attempt: 1, workspace: "unused" })
      store.setSandboxCleanupPending("r", true)
      store.requireDataCapability("frozen-artifacts")
      store.fixedAttachmentReads.reserve("r", "solver", "misc1")
    } finally {
      store.close()
    }
    await writeFile(
      join(candidate, "runtime-data-capabilities.json"),
      JSON.stringify({ schemaVersion: 1, read: old }),
    )
    await expect(assertDataCompatible(candidate, root)).rejects.toMatchObject({
      code: "source_update_data_incompatible",
    })
    expect(await requiredDataCapabilities(root)).toMatchObject({
      "pending-sandbox-cleanup": 1,
      "frozen-artifacts": 1,
      "fixed-attachment-reads": 1,
    })
    await expect(
      assertDataCompatible(fileURLToPath(new URL("../../../", import.meta.url)), root),
    ).resolves.toBeUndefined()
  })

  it("rejects malformed declaration versions even if no database yet needs them", async () => {
    const { root, candidate } = await fixture()
    await writeFile(
      join(candidate, "runtime-data-capabilities.json"),
      JSON.stringify({ schemaVersion: 1, read: { unknown: 0 } }),
    )
    await expect(assertDataCompatible(candidate, root)).rejects.toThrow("Invalid candidate")
  })

  it.runIf(process.platform === "win32")(
    "records why automatic recovery was blocked after a failed restart",
    async () => {
      const { root, candidate, state } = await fixture()
      database(state, { "bounded-subagent-reports": 1 })
      await writeFile(
        join(candidate, "runtime-data-capabilities.json"),
        JSON.stringify({ schemaVersion: 1, read: { "bounded-subagent-reports": 1 } }),
      )
      const old = join(root, "old")
      await mkdir(old)
      const currentPath = join(root, "current")
      await symlink(old, currentPath, "junction")
      const revision = "a".repeat(40)
      await writeFile(
        join(root, ".source-updater-worker.json"),
        JSON.stringify({
          version: 1,
          operation: {
            id: "recovery",
            repository: "acme/agent",
            revision,
            version: null,
            stagingDirectory: candidate,
            status: "prepared",
            currentRevision: null,
            previousTarget: null,
            message: "prepared",
            updatedAt: new Date().toISOString(),
          },
        }),
      )
      const worker = await SourceUpdateWorker.open({
        host: "127.0.0.1",
        port: 0,
        token: "test",
        repository: "acme/agent",
        deploymentRoot: root,
        releasesDirectory: join(root, "releases"),
        currentPath,
        previousPath: join(root, "previous"),
        serviceName: "test.service",
        healthUrl: "http://127.0.0.1:3000/health",
        allowApply: true,
        runSandboxBuild: false,
        dataRoot: root,
      })
      // Windows service restart is explicitly unsupported, so this enters recovery
      // without executing a real service command. The old reader cannot read this DB.
      await expect(
        worker.apply({
          operationId: "recovery",
          repository: "acme/agent",
          revision,
          expectedCurrentRevision: null,
        }),
      ).rejects.toMatchObject({ code: "source_update_data_incompatible" })
      expect(await readlink(currentPath)).toContain("candidate")
      expect(await worker.status()).toMatchObject({
        operation: { status: "failed", message: expect.stringContaining("自动恢复已停止") },
      })
    },
  )

  it("refuses actual apply and rollback before changing deployment links", async () => {
    const { root, candidate, state } = await fixture()
    database(state, { "bounded-subagent-reports": 1 })
    const operation = {
      id: "test",
      repository: "acme/agent",
      revision: "a".repeat(40),
      version: null,
      stagingDirectory: candidate,
      status: "prepared",
      currentRevision: null,
      previousTarget: candidate,
      message: "prepared",
      updatedAt: new Date().toISOString(),
    }
    await writeFile(
      join(root, ".source-updater-worker.json"),
      JSON.stringify({ version: 1, operation }),
    )
    const currentPath = join(root, "current")
    const worker = await SourceUpdateWorker.open({
      host: "127.0.0.1",
      port: 0,
      token: "test",
      repository: "acme/agent",
      deploymentRoot: root,
      releasesDirectory: join(root, "releases"),
      currentPath,
      previousPath: join(root, "previous"),
      serviceName: "test.service",
      healthUrl: "http://127.0.0.1:3000/health",
      allowApply: true,
      runSandboxBuild: false,
      dataRoot: root,
    })
    await expect(
      worker.apply({
        operationId: "test",
        repository: "acme/agent",
        revision: operation.revision,
        expectedCurrentRevision: null,
      }),
    ).rejects.toMatchObject({ code: "source_update_data_incompatible" })
    await expect(worker.rollback({ operationId: "test" })).rejects.toMatchObject({
      code: "source_update_data_incompatible",
    })
    await expect(lstat(currentPath)).rejects.toMatchObject({ code: "ENOENT" })
  })
  it("rejects an unbounded old build and accepts a compatible build even with features disabled", async () => {
    const { root, candidate, state } = await fixture()
    database(state, { "accepted-fact": 1, "bounded-subagent-reports": 1 })
    await expect(assertDataCompatible(candidate, root)).rejects.toMatchObject({
      code: "source_update_data_incompatible",
    })
    await writeFile(
      join(candidate, "runtime-data-capabilities.json"),
      JSON.stringify({
        schemaVersion: 1,
        read: { "accepted-fact": 1, "bounded-subagent-reports": 1 },
      }),
    )
    await expect(assertDataCompatible(candidate, root)).resolves.toBeUndefined()
  })
  it("includes archived project databases and refuses newer versions", async () => {
    const { root, candidate, state } = await fixture()
    const project = join(state, "projects", "a".repeat(32))
    await mkdir(project, { recursive: true })
    database(project, { "bounded-subagent-reports": 2 })
    await writeFile(
      join(candidate, "runtime-data-capabilities.json"),
      JSON.stringify({ schemaVersion: 1, read: { "bounded-subagent-reports": 1 } }),
    )
    expect(await requiredDataCapabilities(root)).toEqual({ "bounded-subagent-reports": 2 })
    await expect(assertDataCompatible(candidate, root)).rejects.toThrow(
      "bounded-subagent-reports@2",
    )
  })
  it("allows a restored legacy backup but never guesses a missing deployment data root", async () => {
    const { root, candidate, state } = await fixture()
    const db = new DatabaseSync(join(state, "runs.sqlite"))
    db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)")
    db.close()
    await expect(assertDataCompatible(candidate, root)).resolves.toBeUndefined()
    await expect(assertDataCompatible(candidate)).rejects.toThrow("CTF_AGENT_UPDATE_DATA_ROOT")
  })
  it("fails closed on corrupt databases and corrupt manifests", async () => {
    const { root, candidate, state } = await fixture()
    await writeFile(join(state, "runs.sqlite"), "not a database")
    await expect(assertDataCompatible(candidate, root)).rejects.toThrow()
    await rm(join(state, "runs.sqlite"))
    await writeFile(join(candidate, "runtime-data-capabilities.json"), "{}")
    await expect(assertDataCompatible(candidate, root)).rejects.toThrow("Invalid candidate")
  })
})
