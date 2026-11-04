import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"
import { DockerProcessSession, DockerSandbox, executeDockerCommand } from "../src/index.ts"

// P4-a: real Docker only. Opt in with DOCKER_LIVE=1 and a built
// ctf-agent-solver:latest image (override with DOCKER_LIVE_IMAGE).
const live = process.env.DOCKER_LIVE === "1"
const image = process.env.DOCKER_LIVE_IMAGE ?? "ctf-agent-solver:latest"

function collect(session: DockerProcessSession) {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  session.onStdout((chunk) => stdout.push(chunk))
  session.onStderr((chunk) => stderr.push(chunk))
  return {
    stdout: () => Buffer.concat(stdout),
    stderr: () => Buffer.concat(stderr),
  }
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for process output")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.skipIf(!live)("DockerProcessSession (P4-a, real Docker)", () => {
  let sandbox: DockerSandbox
  let workspace: string

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "p4a-"))
    sandbox = await DockerSandbox.create({
      projectId: "p4a",
      runId: `p4a-${Date.now()}`,
      image,
      workspace,
      privileged: false,
      networkMode: "none",
    })
  }, 120_000)

  afterAll(async () => {
    await sandbox?.close()
    await rm(workspace, { recursive: true, force: true })
  })

  it("answers two rounds of stdin before end of input, then exits on EOF", async () => {
    const session = DockerProcessSession.start(
      sandbox.id,
      'while IFS= read -r line; do echo "got:$line"; done; echo eof',
    )
    const output = collect(session)
    await session.write("one\n")
    await waitFor(() => output.stdout().toString().includes("got:one"))
    await session.write("two\n")
    await waitFor(() => output.stdout().toString().includes("got:two"))
    expect(session.running).toBe(true)
    session.endInput()
    expect(await session.exited).toEqual({ code: 0, signal: null })
    expect(output.stdout().toString()).toBe("got:one\ngot:two\neof\n")
  }, 60_000)

  it("keeps stdout and stderr as separate raw byte streams", async () => {
    const payload = Buffer.concat([
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
      Buffer.from("\r\n\0\0\r\r\n", "latin1"),
      Buffer.alloc(256 * 1024, 0xab),
    ])
    const session = DockerProcessSession.start(sandbox.id, "cat; printf 'err\\000tail' >&2")
    const output = collect(session)
    await session.write(payload)
    session.endInput()
    expect(await session.exited).toEqual({ code: 0, signal: null })
    expect(output.stdout().equals(payload)).toBe(true)
    expect(output.stderr()).toEqual(Buffer.from("err\0tail", "latin1"))
  }, 60_000)

  it("stops the whole process group inside the container", async () => {
    const marker = `p4a-${Date.now()}`
    const session = DockerProcessSession.start(
      sandbox.id,
      `sleep 300 & sleep 301 & echo ${marker}; wait`,
    )
    const output = collect(session)
    await waitFor(() => output.stdout().toString().includes(marker))
    const group = await session.processGroupId()
    expect(group).toBeGreaterThan(1)
    const exit = await session.stop({ graceMs: 2_000 })
    // The attached client reports the command's own fate, not a launcher's.
    expect(exit).not.toEqual({ code: 0, signal: null })
    expect(session.running).toBe(false)
    // Killed children may linger as zombies when the container has no init to
    // reap them; only processes that are still alive count as a leak.
    const alive = await executeDockerCommand([
      "exec",
      sandbox.id,
      "sh",
      "-c",
      `ps -e -o pgid=,pid=,stat= | awk -v group=${group} '$1 == group && $3 !~ /^Z/'`,
    ])
    expect(alive.stdout.trim()).toBe("")
  }, 60_000)
})
