import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  challengeWorkspacePath,
  Project,
  RunStore,
  type ArtifactRef,
  type ExperimentRecord,
} from "@ctf-agent/core"
import { expect, it } from "vite-plus/test"
import { createWebUiApp } from "../src/server.ts"

it("saves, browses and resets an offline Run through project-scoped evidence endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-api-"))
  const state = join(root, ".ctf-agent")
  const workspace = challengeWorkspacePath(state, "sample")
  const openProject = () =>
    Project.openLocal({
      root,
      platforms: [],
      config: {
        version: 1,
        project: { id: "local", name: "Local" },
        sandbox: { image: "unused", privileged: false, networkMode: "none" },
        platform: { plugin: "offline", config: {} },
      },
      sandboxFactory: async () => {
        throw new Error("no sandbox in this test")
      },
    })
  let project: Project | undefined
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, "example.txt"), "本地文件")
    const store = await RunStore.open(join(state, "runs.sqlite"))
    let fixedSessionId: string
    let processSessionId: string
    try {
      for (const id of ["one", "two"]) {
        await mkdir(join(state, "runs", id), { recursive: true })
        store.createRun({ id, challengeId: "sample", workspace, attempt: id === "one" ? 1 : 2 })
        store.updateRun(id, { status: "failed" })
      }
      const reads = store.fixedAttachmentReads
      fixedSessionId = reads.reserve("one", "solver", "misc1").receipt.id
      reads.acknowledge("one", fixedSessionId, 12)
      reads.save(
        "one",
        fixedSessionId,
        1,
        Buffer.concat([Buffer.alloc(12294, 0xff), Buffer.alloc(4102, 0x00)]),
      )
      reads.save(
        "one",
        fixedSessionId,
        2,
        Buffer.concat([Buffer.alloc(12295, 0x81), Buffer.alloc(4102, 0x82)]),
      )
      reads.end("one", fixedSessionId, true)
      const managed = store.localProcesses.reserve({
        runId: "one",
        owner: "worker",
        requestKey: "sample",
        fingerprint: "sample",
        startedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      })
      processSessionId = managed.receipt.id
      const processDirectory = join(state, "runs", "one", "processes", processSessionId)
      await mkdir(processDirectory, { recursive: true })
      await writeFile(join(processDirectory, "stdout.bin"), Buffer.from([0x00, 0xff, 0x41]))
      await writeFile(join(processDirectory, "stderr.bin"), Buffer.from([0x42]))
      store.localProcesses.finish("one", processSessionId, {
        state: "exited",
        exitCode: 0,
        stopReason: null,
        stdoutBytes: 3,
        stderrBytes: 1,
        cleanupState: "confirmed",
      })
    } finally {
      store.close()
    }
    project = await openProject()
    let { app } = createWebUiApp({ project })
    const base = "/api/projects/local/runs/one"
    const fixedLog = base + "/fixed-attachments/" + fixedSessionId + "/log"
    const boundary = await app.request(fixedLog + "?stream=stdout&offset=12293&limitBytes=2")
    expect(boundary.status).toBe(200)
    expect(boundary.headers.get("Cache-Control")).toBe("no-store")
    const fixedPage = await boundary.json()
    expect(fixedPage).toMatchObject({
      session: {
        sessionId: fixedSessionId,
        runId: "one",
        state: "exited",
        windows: 2,
        exitCode: 0,
      },
      stream: "stdout",
      encoding: "base64",
      offset: 12293,
      nextOffset: 12295,
      byteLength: 24589,
      content: Buffer.from([0xff, 0x81]).toString("base64"),
    })
    expect(
      await (await app.request(fixedLog + "?stream=stderr&offset=4101&limitBytes=2")).json(),
    ).toMatchObject({ byteLength: 8204, content: Buffer.from([0x00, 0x82]).toString("base64") })
    expect((await app.request(fixedLog + "?stream=stdout&offset=24590")).status).toBe(400)
    expect((await app.request(fixedLog + "?stream=stdout&stream=stderr")).status).toBe(400)
    expect((await app.request(fixedLog + "?stream=input")).status).toBe(400)
    expect((await app.request(fixedLog + "?stream=stdout&encoding=utf8")).status).toBe(422)
    expect((await app.request(fixedLog.replace("/one/", "/two/") + "?stream=stdout")).status).toBe(
      404,
    )
    expect(
      (await app.request(fixedLog.replace("/local/", "/elsewhere/") + "?stream=stdout")).status,
    ).toBe(404)
    const processLog = base + "/processes/" + processSessionId + "/log"
    expect(await (await app.request(processLog + "?stream=stdout&offset=1")).json()).toMatchObject({
      stream: "stdout",
      offset: 1,
      nextOffset: 3,
      content: Buffer.from([0xff, 0x41]).toString("base64"),
      session: { state: "exited", exitCode: 0, owner: "worker" },
    })
    expect(
      (await app.request(processLog.replace("/one/", "/two/") + "?stream=stdout")).status,
    ).toBe(404)
    expect((await app.request(processLog + "?stream=stdin")).status).toBe(400)
    const live = "/api/projects/local/challenges/sample/files/range"
    expect(
      await (
        await app.request(live + "?path=example.txt&offset=3&limitBytes=4&encoding=utf8")
      ).json(),
    ).toMatchObject({ content: "地", offset: 3, nextOffset: 6, byteLength: 12 })
    expect((await app.request(live + "?path=..%2F..%2Fprivate")).status).toBe(400)
    const post = (url: string, body: unknown) =>
      app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    const created = await post(base + "/artifacts", { path: "example.txt" })
    expect(created.status).toBe(201)
    const ref = (await created.json()) as ArtifactRef
    const file = base + "/artifacts/" + ref.refId
    expect(
      (await app.request(file + "/content?encoding=utf8&limitBytes=4")).headers.get(
        "Cache-Control",
      ),
    ).toBe("no-store")
    expect(
      await (await app.request(file + "/content?encoding=utf8&limitBytes=4")).json(),
    ).toMatchObject({ content: "本", nextOffset: 3, hasMore: true })
    expect((await app.request(file + "/content?offset=9&offset=0")).status).toBe(400)
    expect((await app.request(file + "/content?limitBytes=0")).status).toBe(400)
    expect((await app.request(file + "/content?encoding=utf8&offset=1")).status).toBe(422)
    expect((await app.request(file.replace("/local/", "/elsewhere/") + "/content")).status).toBe(
      404,
    )
    expect((await app.request(file.replace("/one/", "/two/") + "/content")).status).toBe(404)
    expect((await post(base + "/artifacts", { path: "../host" })).status).toBe(400)
    expect(
      (await post(base + "/artifacts", { path: "example.txt", command: "unused" })).status,
    ).toBe(400)
    expect(
      (
        await post(base + "/experiments", {
          status: "unknown",
          exitCode: 0,
          inputRefs: [ref.refId],
        })
      ).status,
    ).toBe(400)
    const saved = await post(base + "/experiments", {
      status: "unknown",
      inputRefs: [ref.refId],
      note: "人工观察",
    })
    expect(saved.status).toBe(201)
    const linked = await post(base + "/experiments", {
      status: "exited",
      processSessionId,
    })
    expect(linked.status).toBe(201)
    expect((await linked.json()).processSessionId).toBe(processSessionId)
    const record = (await saved.json()) as ExperimentRecord
    await project.close()
    project = await openProject()
    app = createWebUiApp({ project }).app
    expect(
      await (await app.request(fixedLog + "?stream=stdout&offset=12293&limitBytes=2")).json(),
    ).toEqual(fixedPage)
    expect(project.diagnostics().filter((d) => d.code === "evidence")).toEqual([])
    expect(await (await app.request(base + "/artifacts")).json()).toEqual({ ids: [ref.refId] })
    expect(await (await app.request(base + "/experiments/" + record.id)).json()).toEqual(record)
    expect(await (await post(file + "/verify", {})).json()).toEqual(ref)
    await project.resetChallenge("sample")
    expect((await app.request(file + "/content")).status).toBe(404)
    expect((await app.request(fixedLog + "?stream=stdout")).status).toBe(404)
  } finally {
    await project?.close()
    await rm(root, { recursive: true, force: true })
  }
})
