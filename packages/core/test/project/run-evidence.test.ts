import { createHash, randomUUID } from "node:crypto"
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { RunStore } from "../../src/persistence/run-store.ts"
import { readArtifactRange } from "../../src/project/artifact-range-reader.ts"
import * as ranges from "../../src/project/artifact-range-reader.ts"
import { challengeWorkspacePath } from "../../src/project/challenge-workspace.ts"
import { RunEvidence } from "../../src/project/experiment-record.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")
async function setup(limit?: number) {
  const state = await mkdtemp(join(tmpdir(), "run-evidence-"))
  const workspace = challengeWorkspacePath(state, "sample")
  await mkdir(workspace, { recursive: true })
  const db = join(state, "runs.sqlite")
  const store = await RunStore.open(db)
  for (const id of ["run1", "run2"]) {
    store.createRun({ id, challengeId: "sample", workspace, attempt: id === "run1" ? 1 : 2 })
    store.updateRun(id, { status: "failed" })
    await mkdir(join(state, "runs", id), { recursive: true })
  }
  const evidence = new RunEvidence(state, store, limit)
  cleanup.push(async () => {
    await evidence.close()
    store.close()
    await rm(state, { recursive: true, force: true })
  })
  return {
    state,
    db,
    store,
    workspace,
    evidence,
    artifacts: join(state, "runs", "run1", "artifacts"),
  }
}

describe("Run file evidence", () => {
  it("freezes a binary prefix and an empty file independently of source appends and replacements", async () => {
    const { workspace, evidence, store } = await setup()
    const original = Buffer.from([0, 255, 8, 7, 2])
    const path = join(workspace, "trace.bin")
    await writeFile(path, original)
    const ref = await evidence.capture("run1", {
      path: "trace.bin",
      prefixBytes: 3,
      expectedSha256: sha(original.subarray(0, 3)),
    })
    expect(ref).toMatchObject({ state: "growing-prefix", byteLength: 3 })
    await appendFile(path, "later")
    await rename(path, path + ".old")
    await writeFile(path, "")
    await expect(
      evidence.content("run1", ref.refId, { offset: 1, limitBytes: 1 }),
    ).resolves.toMatchObject({ content: "/w==", nextOffset: 2, hasMore: true })
    await expect(evidence.verify("run1", ref.refId)).resolves.toEqual(ref)
    await expect(
      evidence.capture("run1", { path: "trace.bin", expectedSha256: ref.sha256 }),
    ).rejects.toMatchObject({ code: "artifact_changed" })
    const empty = await evidence.capture("run1", { path: "trace.bin" })
    expect(await evidence.content("run1", empty.refId, {})).toMatchObject({
      content: "",
      nextOffset: 0,
      hasMore: false,
    })
    expect(store.events("run1", "registered_evidence")).toHaveLength(2)
    expect(store.dataCapabilities()["frozen-artifacts"]).toBe(1)
  })

  it("advances by raw UTF-8 bytes, preserves BOM and refuses malformed or incomplete code points", async () => {
    const { workspace, evidence } = await setup()
    await writeFile(
      join(workspace, "text"),
      Buffer.concat([Buffer.from("\ufeffA中🌍"), Buffer.from([0xef])]),
    )
    const { refId } = await evidence.capture("run1", { path: "text" })
    const page = (offset: number, limitBytes: number) =>
      evidence.content("run1", refId, { offset, limitBytes, encoding: "utf8" })
    expect(await page(0, 6)).toMatchObject({ content: "\ufeffA", nextOffset: 4 })
    expect(await page(4, 6)).toMatchObject({ content: "中", nextOffset: 7 })
    expect(await page(7, 4)).toMatchObject({ content: "🌍", nextOffset: 11 })
    for (const [offset, length] of [
      [5, 4],
      [7, 2],
      [11, 1],
    ])
      await expect(page(offset!, length!)).rejects.toMatchObject({ code: "invalid_encoding" })
    expect(await page(12, 1)).toMatchObject({ content: "", hasMore: false })
    await expect(page(13, 1)).rejects.toMatchObject({ code: "invalid_offset" })
    for (const limit of [0, 32769, 1.5])
      await expect(page(0, limit)).rejects.toMatchObject({ code: "invalid_query" })
  })

  it("uses positional IO near the end of a large sparse file", async () => {
    const { workspace } = await setup()
    const file = await open(join(workspace, "sparse"), "wx+")
    try {
      const at = 32 * 1024 * 1024
      await file.write(Buffer.from("page"), 0, 4, at)
      const read = vi.spyOn(file, "read")
      const whole = vi.spyOn(file, "readFile")
      expect(
        await readArtifactRange(file, at + 4, { offset: at, limitBytes: 2, encoding: "utf8" }),
      ).toMatchObject({ content: "pa", nextOffset: at + 2 })
      expect(read).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 2, at)
      expect(whole).not.toHaveBeenCalled()
    } finally {
      await file.close()
    }
  })

  it("rejects replacement during publication and serves the first page without rehashing the copy", async () => {
    const { evidence, workspace, store } = await setup()
    const source = join(workspace, "chunks")
    const bytes = Buffer.concat([
      Buffer.alloc(65536, 11),
      Buffer.alloc(65536, 27),
      Buffer.from("end"),
    ])
    await writeFile(source, bytes)
    const hash = ranges.hashFilePrefix
    const spy = vi.spyOn(ranges, "hashFilePrefix")
    try {
      spy.mockImplementationOnce(async (file, count, target) => {
        const digest = await hash(file, count, target)
        await rename(source, source + ".old")
        await writeFile(source, bytes)
        return digest
      })
      await expect(evidence.capture("run1", { path: "chunks" })).rejects.toMatchObject({
        code: "artifact_changed",
      })
      expect(await evidence.list("run1", "artifacts")).toEqual({ ids: [] })
      expect(store.events("run1", "registered_evidence")).toEqual([])
      const ref = await evidence.capture("run1", { path: "chunks" })
      expect(ref.sha256).toBe(sha(bytes))
      spy.mockClear()
      const page = await evidence.content("run1", ref.refId, { offset: 65535, limitBytes: 2 })
      expect(page.content).toBe(bytes.subarray(65535, 65537).toString("base64"))
      expect(spy).not.toHaveBeenCalled()
      await evidence.verify("run1", ref.refId)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it("rejects cross-Run IDs, traversal, host aliases and links outside the workspace", async () => {
    const { state, workspace, evidence } = await setup()
    await mkdir(join(state, "other"))
    await writeFile(join(state, "other", "private"), "private")
    await symlink(
      join(state, "other"),
      join(workspace, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await link(join(state, "other", "private"), join(workspace, "hard"))
    for (const path of [
      "../other/private",
      "/etc/hosts",
      "C:/temp",
      "bad:stream",
      "alias/private",
      "hard",
    ]) {
      await expect(evidence.capture("run1", { path })).rejects.toMatchObject({
        code: "invalid_query",
      })
    }
    await writeFile(join(workspace, "public"), "ok")
    const ref = await evidence.capture("run1", { path: "public" })
    await expect(evidence.content("run2", ref.refId, {})).rejects.toMatchObject({
      code: "artifact_not_found",
    })
    await expect(
      evidence.record("run2", { inputRefs: [ref.refId], status: "unknown" }),
    ).rejects.toMatchObject({ code: "artifact_not_found" })
    await expect(evidence.list("../run1", "artifacts")).rejects.toMatchObject({
      code: "artifact_not_found",
    })
  })

  it("reserves retention across concurrent writers and includes sidecars after reopening", async () => {
    const { state, workspace, store, evidence } = await setup(700)
    await writeFile(join(workspace, "log"), Buffer.alloc(220))
    const captures = await Promise.allSettled(
      [1, 2].map(() => evidence.capture("run1", { path: "log" })),
    )
    expect(captures.map((r) => r.status)).toEqual(["fulfilled", "rejected"])
    expect(captures[1]).toMatchObject({ reason: { code: "artifact_storage_limit" } })
    await evidence.close()
    const reopened = new RunEvidence(state, store, 700)
    const report = vi.fn()
    try {
      await reopened.recover(report)
      expect(report).not.toHaveBeenCalled()
      await expect(reopened.capture("run1", { path: "log" })).rejects.toMatchObject({
        code: "artifact_storage_limit",
      })
      await expect(reopened.capture("run2", { path: "log" })).resolves.toMatchObject({
        runId: "run2",
      })
    } finally {
      await reopened.close()
    }
  })

  it("recovers published observations, repairs a missing event and detects tampering against the registered digest", async () => {
    const { workspace, store, state, db, artifacts, evidence } = await setup()
    const path = join(workspace, "notes")
    await writeFile(path, "abcd")
    const original = await evidence.capture("run1", { path: "notes" })
    const ref = await evidence.capture("run1", { path: "notes", prefixBytes: 2 })
    const record = await evidence.record("run1", {
      status: "exited",
      exitCode: 0,
      scriptRef: original.refId,
      inputRefs: [ref.refId],
      stdoutRef: ref.refId,
      note: "observer",
    })
    expect(record).toMatchObject({
      recordedBy: "operator",
      imageDigest: "unknown",
      script: { sha256: sha("abcd") },
      inputs: [{ sha256: sha("ab") }],
      executionId: null,
      exitCode: 0,
    })
    const detail = store.events("run1", "registered_evidence").at(-1)?.data
    expect(detail).toMatchObject({ experimentId: record.id, status: "exited" })
    expect(detail).not.toHaveProperty("note")
    await evidence.close()
    const raw = new DatabaseSync(db)
    try {
      raw
        .prepare(
          "DELETE FROM run_events WHERE type = 'experiment_recorded' OR (type='artifact_registered' AND json_extract(data_json,'$.refId')=?)",
        )
        .run(ref.refId)
    } finally {
      raw.close()
    }
    const stage = join(artifacts, ".pending-" + randomUUID())
    await mkdir(stage)
    await writeFile(join(artifacts, original.refId, "content.bin"), "fake")
    const meta = join(artifacts, original.refId, "reference.json")
    await writeFile(
      meta,
      JSON.stringify({ ...JSON.parse(await readFile(meta, "utf8")), sha256: sha("fake") }),
    )
    const reopened = new RunEvidence(state, store)
    try {
      const report = vi.fn()
      await reopened.recover(report)
      expect(report).toHaveBeenCalledExactlyOnceWith(
        "run1",
        expect.stringContaining(original.refId),
      )
      expect(await reopened.experiment("run1", record.id)).toEqual(record)
      expect((await reopened.list("run1", "artifacts", undefined, 1)).nextCursor).toBeTruthy()
      await expect(reopened.content("run1", original.refId, {})).rejects.toMatchObject({
        code: "artifact_changed",
      })
      await expect(reopened.verify("run1", ref.refId)).resolves.toEqual(ref)
      await expect(readFile(stage)).rejects.toMatchObject({ code: "ENOENT" })
      expect(store.events("run1", "registered_evidence")).toHaveLength(3)
      await rm(join(artifacts, ref.refId), { recursive: true })
      await expect(reopened.verify("run1", ref.refId)).rejects.toMatchObject({
        code: "artifact_changed",
      })
    } finally {
      await reopened.close()
    }
  })
})
