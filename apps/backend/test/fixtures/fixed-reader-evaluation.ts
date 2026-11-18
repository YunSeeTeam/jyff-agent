import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { RunEvidence } from "@ctf-agent/core"
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux"
import {
  archive,
  docker,
  expectedFixedWindow,
  fixedReaderProject,
  fixedTool,
} from "../../../../packages/core/test/project/fixtures/fixed-reader-project.ts"
import { createWebUiApp } from "../../src/server.ts"

// Run with an empty destination and the inspected ID of a cached image.
const [sample, destination, image] = process.argv.slice(2)
if ((sample !== "misc1" && sample !== "misc2") || !destination || !image)
  throw new Error("Expected misc1 or misc2, a new result directory and a cached image ID")
const output = resolve(destination)
await mkdir(output)
const root = join(output, "project")
await mkdir(root)
const projectId = "fixed-eval-" + randomUUID()
const input = await archive(sample)
const first = expectedFixedWindow(input, 1)
const second = expectedFixedWindow(input, 2)
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const containers = async () =>
  (await docker(["ps", "-aq", "--filter", "label=ctf-agent.project=" + projectId]))
    .split(/\s+/)
    .filter(Boolean)
const startedAt = new Date().toISOString()
const start = performance.now()
let modelCalls = 0
const agent = {
  initialState: { model: createFauxCore({ provider: "offline-fixed-reader" }).getModel() },
  streamFn: () => {
    modelCalls++
    throw new Error("Offline fixed evaluation does not send model requests")
  },
}
const project = await fixedReaderProject(root, projectId, image, [sample])
let session
let active
let elapsedReadMs
let elapsedCleanupMs
try {
  assert.equal(project.runs().length, 0)
  const solver = await project.createSolver(sample, { agent })
  const read = fixedTool(solver)
  const launched = await read("open")
  assert.equal(launched.state, "reading")
  assert.ok(launched.pid && launched.pid > 0)
  assert.deepEqual(await read("open"), launched)
  assert.equal((await read("first", launched.sessionId)).windows, 1)
  assert.equal((await read("second", launched.sessionId)).windows, 2)
  session = await read("finish", launched.sessionId)
  assert.equal(session.pid, launched.pid)
  assert.equal(session.state, "exited")
  assert.equal(session.exitCode, 0)
  assert.equal(session.windows, 2)
  assert.deepEqual(await read("finish", launched.sessionId), session)
  assert.deepEqual(await read("open"), session)
  elapsedReadMs = Math.round(performance.now() - start)
  active = await containers()
  assert.equal(active.length, 1)
  assert.equal(
    await docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", active[0]!]),
    "none",
  )
  const closeStart = performance.now()
  await solver.close("manual")
  assert.deepEqual(await containers(), [])
  elapsedCleanupMs = Math.round(performance.now() - closeStart)
} finally {
  await project.close()
}

type LogPage = Awaited<ReturnType<RunEvidence["fixedAttachmentLog"]>>
const reopened = await fixedReaderProject(root, projectId, image, [sample])
const logs = []
try {
  const { app } = createWebUiApp({ project: reopened })
  const url = `/api/projects/${projectId}/runs/${session.runId}/fixed-attachments/${session.sessionId}/log`
  for (const stream of ["stdout", "stderr"] as const) {
    const expected = Buffer.concat([first[stream], second[stream]])
    const buffers: Buffer[] = []
    let offset = 0
    do {
      const response = await app.request(url + `?stream=${stream}&offset=${offset}&limitBytes=4096`)
      assert.equal(response.status, 200)
      const page = (await response.json()) as LogPage
      const bytes = Buffer.from(page.content, "base64")
      assert.deepEqual(page.session, session)
      assert.equal(page.encoding, "base64")
      assert.equal(page.offset, offset)
      assert.equal(page.byteLength, expected.length)
      assert.ok(bytes.length > 0 && bytes.length <= 4096)
      assert.equal(page.nextOffset, offset + bytes.length)
      assert.equal(page.hasMore, page.nextOffset < expected.length)
      offset = page.nextOffset
      buffers.push(bytes)
    } while (offset < expected.length)
    const bytes = Buffer.concat(buffers)
    assert.deepEqual(bytes, expected)
    const file = stream + ".bin"
    await writeFile(join(output, file), bytes, { flag: "wx" })
    logs.push({ stream, file, bytes: bytes.length, sha256: sha256(bytes), pages: buffers.length })
  }
  assert.equal(reopened.runs().length, 1)
  assert.deepEqual(await containers(), [])
  assert.equal(modelCalls, 0)
} finally {
  await reopened.close()
}

const result = {
  sample,
  inputSha256: sha256(input),
  projectId,
  image,
  containers: active,
  session,
  logs,
  startedAt,
  elapsedReadMs,
  elapsedCleanupMs,
  wallMs: Math.round(performance.now() - start),
  modelCalls,
  spendCny: 0,
  testContainersRemaining: 0,
}
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
console.info("fixed attachment sample verified", JSON.stringify(result))
