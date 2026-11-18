import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { DockerManagedProcess, DockerSandbox, executeDockerCommand } from "@ctf-agent/sandbox"
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux"
import { describe, expect, it, vi } from "vite-plus/test"
import { defaultRunSettings, mergeRunSettings } from "../../src/contracts/run-settings.ts"
import { RunStore } from "../../src/persistence/run-store.ts"
import { LocalProcessManager } from "../../src/project/local-process-manager.ts"
import { RunEvidence } from "../../src/project/experiment-record.ts"
import { Project } from "../../src/project/project.ts"
import { TestPlatformPlugin } from "../fake-platform.ts"
import { fileURLToPath } from "node:url"

const scratchRoot = resolve(process.cwd(), "../outputs/tmp")

describe.runIf(process.env.DOCKER_LOCAL_PROCESSES === "1")("managed process in Docker", () => {
  it("keeps raw dual-stream output and an idempotent Run receipt", async () => {
    await mkdir(scratchRoot, { recursive: true })
    const root = await mkdtemp(join(scratchRoot, "local-process-"))
    const runId = randomUUID()
    const projectId = randomUUID()
    const workspace = join(root, "workspace")
    const logs = join(root, "runs", runId, "processes")
    await Promise.all([mkdir(workspace), mkdir(logs, { recursive: true })])
    const store = await RunStore.open(join(root, "runs.sqlite"))
    store.createRun({ id: runId, challengeId: "offline", workspace, attempt: 1 })
    let sandbox: DockerSandbox | undefined
    try {
      sandbox = await DockerSandbox.create({
        projectId,
        runId,
        image: process.env.DOCKER_LIVE_IMAGE ?? "ctf-agent-solver:latest",
        workspace,
        processLogDirectory: logs,
        privileged: false,
        networkMode: "none",
      })
      const manager = new LocalProcessManager(runId, store.localProcesses, sandbox, logs, 10)
      const tools = new Map(manager.tools("worker").map((tool) => [tool.name, tool]))
      const invoke = async (name: string, params: object) => {
        const result = await tools.get(name)!.execute(randomUUID(), params)
        return result.details as Record<string, unknown>
      }
      const command =
        "python3 -u -c 'import sys; a=sys.stdin.buffer.read(2); b=sys.stdin.buffer.read(); sys.stdout.buffer.write(a+b+bytes([0,255])); sys.stderr.buffer.write(bytes([255,0])+b)'"
      const first = await invoke("process_start", { requestKey: "two-inputs", command })
      const sessionId = first.sessionId as string
      const repeated = await invoke("process_start", {
        requestKey: "two-inputs",
        command,
        yieldMs: 0,
      })
      expect(repeated.sessionId).toBe(sessionId)
      await expect(
        invoke("process_start", { requestKey: "two-inputs", command: "echo changed" }),
      ).rejects.toThrow("request_key_conflict")
      // start may have returned while the supervisor was still handshaking.
      for (let attempt = 0; attempt < 30; attempt++) {
        const page = await invoke("process_list", {})
        if ((page.sessions as Array<{ state: string }>)[0]?.state === "running") break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect((await invoke("process_write", { sessionId, text: "AB" })).acceptedBytes).toBe(2)
      expect(
        (await invoke("process_write", { sessionId, base64: "Q0Q=", eof: true })).acceptedBytes,
      ).toBe(2)
      let result: Record<string, unknown> = {}
      for (let attempt = 0; attempt < 30; attempt++) {
        result = await invoke("process_poll", { sessionId, waitMs: 500, limitBytes: 32 })
        if (result.state === "exited") break
      }
      expect(result.state).toBe("exited")
      expect(result.exitCode).toBe(0)
      expect(Buffer.from((result.stdout as { content: string }).content, "base64")).toEqual(
        Buffer.from([65, 66, 67, 68, 0, 255]),
      )
      expect(Buffer.from((result.stderr as { content: string }).content, "base64")).toEqual(
        Buffer.from([255, 0, 67, 68]),
      )
      await expect(invoke("process_poll", { sessionId, encoding: "utf8" })).rejects.toThrow()
      expect((await invoke("process_stop", { sessionId })).state).toBe("exited")
      const evidence = new RunEvidence(root, store)
      const stdout = await evidence.processLog(runId, sessionId, "stdout", { limitBytes: 3 })
      expect(Buffer.from(stdout.content, "base64")).toEqual(Buffer.from([65, 66, 67]))
      const tail = await evidence.processLog(runId, sessionId, "stdout", {
        offset: stdout.nextOffset,
      })
      expect(Buffer.from(tail.content, "base64")).toEqual(Buffer.from([68, 0, 255]))
      const experiment = await evidence.record(runId, {
        processSessionId: sessionId,
        status: "exited",
      })
      expect((await evidence.experiment(runId, experiment.id)).processSessionId).toBe(sessionId)
      await expect(invoke("process_poll", { sessionId, stdoutOffset: 999 })).rejects.toThrow()
      const other = new Map(manager.tools("other").map((tool) => [tool.name, tool]))
      await expect(other.get("process_poll")!.execute(randomUUID(), { sessionId })).rejects.toThrow(
        "not found in this scope",
      )
      const solver = new Map(manager.tools("solver").map((tool) => [tool.name, tool]))
      expect((await solver.get("process_list")!.execute(randomUUID(), {})).details).toMatchObject({
        sessions: [expect.objectContaining({ sessionId })],
      })
      const sleeping = await invoke("process_start", { requestKey: "sleep", command: "sleep 60" })
      const sleepingId = sleeping.sessionId as string
      const signal = new AbortController()
      setTimeout(() => signal.abort(), 50)
      const waiting = await tools
        .get("process_poll")!
        .execute(randomUUID(), { sessionId: sleepingId, waitMs: 10000 }, signal.signal)
      expect(waiting.details).toMatchObject({ pending: true, state: "running" })
      expect((await invoke("process_stop", { sessionId: sleepingId, graceMs: 200 })).state).toBe(
        "cancelled",
      )
      const timed = await invoke("process_start", {
        requestKey: "deadline",
        command: "sleep 60",
        deadlineMs: 300,
      })
      let timedState = timed.state
      for (let attempt = 0; attempt < 30 && timedState !== "timed_out"; attempt++) {
        timedState = (await invoke("process_poll", { sessionId: timed.sessionId, waitMs: 500 }))
          .state
      }
      expect(timedState).toBe("timed_out")
      const capped = await invoke("process_start", {
        requestKey: "output-limit",
        command: "python3 -c 'import os; os.write(1,b\"x\"*100)'",
      })
      let cappedState = capped.state
      for (let attempt = 0; attempt < 30 && cappedState !== "cancelled"; attempt++) {
        cappedState = (await invoke("process_poll", { sessionId: capped.sessionId, waitMs: 500 }))
          .state
      }
      expect(cappedState).toBe("cancelled")
      const cappedLog = await evidence.processLog(runId, capped.sessionId as string, "stdout", {})
      expect(Buffer.from(cappedLog.content, "base64")).toEqual(Buffer.alloc(10, "x"))
      const failed = await invoke("process_start", {
        requestKey: "bad-cwd",
        command: "echo never",
        cwd: "/workspace/missing-directory",
      })
      expect(failed.state).toBe("failed")
      const [concurrentA, concurrentB] = await Promise.all([
        invoke("process_start", { requestKey: "same-key", command: "sleep 60" }),
        invoke("process_start", { requestKey: "same-key", command: "sleep 60" }),
      ])
      expect(concurrentA.sessionId).toBe(concurrentB.sessionId)
      const second = await invoke("process_start", {
        requestKey: "second-active",
        command: "sleep 60",
      })
      await expect(
        invoke("process_start", { requestKey: "over-owner", command: "sleep 60" }),
      ).rejects.toThrow("local_process_quota")
      expect((await invoke("process_stop", { sessionId: concurrentA.sessionId })).state).toBe(
        "cancelled",
      )
      expect(
        (
          await solver.get("process_stop")!.execute(randomUUID(), {
            sessionId: second.sessionId,
          })
        ).details,
      ).toMatchObject({ state: "cancelled", owner: "worker" })
      const unicode = await invoke("process_start", {
        requestKey: "split-utf8",
        command:
          'python3 -u -c \'import os; os.write(1,b"\\xe2"); os.read(0,1); os.write(1,b"\\x82\\xac")\'',
      })
      let firstByte: Record<string, unknown> = {}
      for (let attempt = 0; attempt < 30; attempt++) {
        firstByte = await invoke("process_poll", { sessionId: unicode.sessionId, waitMs: 500 })
        if ((firstByte.stdout as { byteLength: number }).byteLength === 1) break
      }
      expect((firstByte.stdout as { byteLength: number }).byteLength).toBe(1)
      const partial = await invoke("process_poll", {
        sessionId: unicode.sessionId,
        encoding: "utf8",
      })
      expect(partial).toMatchObject({ pending: true, stdout: { content: "", nextOffset: 0 } })
      await invoke("process_write", { sessionId: unicode.sessionId, text: "x", eof: true })
      for (let attempt = 0; attempt < 30; attempt++) {
        const state = await invoke("process_poll", {
          sessionId: unicode.sessionId,
          stdoutOffset: 3,
          waitMs: 500,
        })
        if (state.state === "exited") break
      }
      const completed = await invoke("process_poll", {
        sessionId: unicode.sessionId,
        encoding: "utf8",
      })
      expect(completed).toMatchObject({ state: "exited", stdout: { content: "€", nextOffset: 3 } })
      await manager.close()
    } finally {
      await sandbox?.close()
      store.close()
      if (resolve(root).startsWith(`${resolve(scratchRoot)}${sep}`))
        await rm(root, { recursive: true, force: true })
    }
  }, 90_000)

  it("exposes the managed tools through a real Project and reopens its retained logs", async () => {
    await mkdir(scratchRoot, { recursive: true })
    const root = await mkdtemp(join(scratchRoot, "local-process-project-"))
    const projectId = randomUUID()
    const config = {
      version: 1 as const,
      project: { id: projectId, name: "Managed process integration" },
      platform: {
        plugin: "test",
        config: {
          challenges: [
            {
              id: "offline",
              title: "Offline",
              category: "misc",
              score: 0,
              description: "Local process test",
              attachments: [],
              flag: "",
            },
          ],
        },
      },
      sandbox: {
        image: process.env.DOCKER_LIVE_IMAGE ?? "ctf-agent-solver:latest",
        networkMode: "none" as const,
        privileged: false,
      },
    }
    const faux = createFauxCore({ provider: "local-process-live" })
    const open = () =>
      Project.open({
        root,
        config,
        platforms: [new TestPlatformPlugin()],
        runSettings: () =>
          mergeRunSettings(defaultRunSettings(), {
            optimization: { localProcesses: true },
          }),
      })
    let project: Project | undefined
    let sessionId = "",
      runId = ""
    try {
      project = await open()
      const solver = await project.createSolver("offline", {
        agent: {
          initialState: { model: faux.getModel() },
          streamFn: () => {
            throw new Error("No model request expected")
          },
        },
      })
      runId = solver.runId
      const tool = (name: string) => solver.tools.find((entry) => entry.name === name)!
      const start = await tool("process_start").execute("test", {
        requestKey: "project-stdout",
        command: "printf 'project-log'",
      })
      sessionId = (start.details as { sessionId: string }).sessionId
      for (let attempt = 0; attempt < 30; attempt++) {
        const observed = await tool("process_poll").execute("test", { sessionId, waitMs: 500 })
        if ((observed.details as { state: string }).state === "exited") break
      }
      for (const requestKey of ["cleanup-a", "cleanup-b"]) {
        await tool("process_start").execute("test", { requestKey, command: "sleep 60" })
      }
      const failOneStop = vi
        .spyOn(DockerManagedProcess.prototype, "stop")
        .mockRejectedValueOnce(new Error("injected process stop failure"))
      try {
        await expect(solver.close("manual")).rejects.toThrow("关闭时发生错误")
        expect(failOneStop).toHaveBeenCalledTimes(2)
        expect(project.runs({ challengeId: "offline" })[0]?.cleanupError).toContain(
          "受管进程回收失败",
        )
      } finally {
        failOneStop.mockRestore()
      }
      const remaining = await executeDockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=ctf-agent.project=${projectId}`,
      ])
      expect(remaining.stdout.trim()).toBe("")
      await project.close().catch(() => undefined)
      project = await Project.openLocal({ root, config, platforms: [] })
      const log = await project.evidence.processLog(runId, sessionId, "stdout", {})
      expect(log.session).toMatchObject({ state: "exited", exitCode: 0 })
      expect(Buffer.from(log.content, "base64").toString()).toBe("project-log")
    } finally {
      await project?.close()
      if (resolve(root).startsWith(`${resolve(scratchRoot)}${sep}`))
        await rm(root, { recursive: true, force: true })
    }
  }, 90_000)

  it("recovers a crashed host without inventing an exit code", async () => {
    await mkdir(scratchRoot, { recursive: true })
    const root = await mkdtemp(join(scratchRoot, "local-process-crash-"))
    const projectId = randomUUID()
    const image = process.env.DOCKER_LIVE_IMAGE ?? "ctf-agent-solver:latest"
    const fixture = fileURLToPath(new URL("./fixtures/local-process-crash.ts", import.meta.url))
    let project: Project | undefined
    try {
      const child = spawn(
        process.execPath,
        ["--experimental-transform-types", fixture, root, projectId, image],
        { cwd: process.cwd(), env: process.env },
      )
      let output = "",
        errors = ""
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString()
      })
      const [code] = await once(child, "close")
      expect(code, errors).toBe(0)
      const receipt = JSON.parse(output.trim().split("\n").at(-1)!) as {
        runId: string
        sessionId: string
      }
      project = await Project.openLocal({
        root,
        config: {
          version: 1,
          project: { id: projectId, name: "Managed process crash" },
          platform: { plugin: "offline", config: {} },
          sandbox: { image, networkMode: "none", privileged: false },
        },
        platforms: [],
      })
      const store = await RunStore.open(join(root, ".ctf-agent", "runs.sqlite"))
      try {
        expect(store.localProcesses.find(receipt.runId, receipt.sessionId, "solver")).toMatchObject(
          { state: "interrupted", exitCode: null, cleanupState: "confirmed" },
        )
      } finally {
        store.close()
      }
      const log = await project.evidence.processLog(receipt.runId, receipt.sessionId, "stdout", {})
      expect(Buffer.from(log.content, "base64").toString()).toBe("crash-prefix")
      const boxes = await executeDockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=ctf-agent.project=${projectId}`,
      ])
      expect(boxes.stdout.trim()).toBe("")
    } finally {
      await project?.close()
      const boxes = await executeDockerCommand([
        "ps",
        "-aq",
        "--filter",
        `label=ctf-agent.project=${projectId}`,
      ])
      const ids = boxes.stdout.trim().split(/\s+/).filter(Boolean)
      if (ids.length) await executeDockerCommand(["rm", "-f", ...ids])
      if (resolve(root).startsWith(`${resolve(scratchRoot)}${sep}`))
        await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
})
