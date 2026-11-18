import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { FixedAttachmentReader, matchFixedAttachment } from "@ctf-agent/sandbox"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { FixedAttachmentReadStore } from "../../src/persistence/fixed-attachment-reads.ts"
import {
  archive,
  docker,
  expectedFixedWindow,
  fixedReaderProject,
  fixedTool,
  type ToolReceipt,
} from "./fixtures/fixed-reader-project.ts"

function observed(context: TranscriptContext, callId: string) {
  const result = context.messages.find(
    (item) => item.role === "toolResult" && item.toolCallId === callId,
  )
  if (result?.role !== "toolResult") throw new Error("Missing actual tool response")
  return {
    failed: result.isError,
    text: result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  }
}

function noModel() {
  return {
    initialState: { model: createFauxCore({ provider: "fixed-reader-lifecycle" }).getModel() },
    streamFn: () => {
      throw new Error("Unexpected model request")
    },
  }
}

async function expectedWindow(sample: "misc1" | "misc2", window: 1 | 2) {
  const { stdout, stderr } = expectedFixedWindow(await archive(sample), window)
  const digest = (data: Buffer) => ({
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  })
  return { window, stdout: digest(stdout), stderr: digest(stderr) }
}

describe.runIf(process.env.DOCKER_FIXED_ATTACHMENTS === "1")(
  "production fixed attachment profile",
  () => {
    let root: string, projectId: string, image: string
    const boxes = async () =>
      (await docker(["ps", "-aq", "--filter", "label=ctf-agent.project=" + projectId]))
        .split(/\s+/)
        .filter(Boolean)
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "fixed-reader-project-"))
      projectId = "fixed-reads-" + randomUUID()
      image = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        process.env.DOCKER_LIVE_IMAGE ?? "ctf-agent-solver:latest",
      ])
    })
    afterEach(async () => {
      try {
        const ids = await boxes()
        if (ids.length) await docker(["rm", "-f", ...ids])
        expect(ids).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3 })
      }
    })

    it("confirms an early stop in the running container and keeps only its acknowledged prefix", async () => {
      const project = await fixedReaderProject(root, projectId, image)
      let stopped!: ToolReceipt
      const startup = vi.spyOn(FixedAttachmentReader.prototype, "ready")
      try {
        const solver = await project.createSolver("misc1", { agent: noModel() })
        const read = fixedTool(solver)
        const starts = await Promise.all(Array.from({ length: 4 }, () => read("open")))
        const opened = starts[0]!
        expect(startup).toHaveBeenCalledTimes(1)
        expect(
          starts.every((start) => start.sessionId === opened.sessionId && start.pid === opened.pid),
        ).toBe(true)
        expect(opened).toMatchObject({ state: "reading", windows: 0, exitCode: null })
        const [box] = await boxes()
        expect(box).toBeTruthy()
        const alive = () =>
          docker([
            "exec",
            box!,
            "python3",
            "-I",
            "-S",
            "-B",
            "-c",
            'import pathlib, sys; print(pathlib.Path("/proc", sys.argv[1]).is_dir())',
            String(opened.pid),
          ])
        expect(await alive()).toBe("True")
        const empty = await project.evidence.fixedAttachmentLog(
          solver.runId,
          opened.sessionId,
          "stdout",
          {},
        )
        expect(empty).toMatchObject({ byteLength: 0, content: "", hasMore: false })
        await read("first", opened.sessionId)
        stopped = await read("finish", opened.sessionId)
        expect(stopped).toMatchObject({ state: "exited", windows: 1, exitCode: 0 })
        expect(await alive()).toBe("False")
        expect(await read("finish", opened.sessionId)).toEqual(stopped)
        expect(await read("open")).toEqual(stopped)
        await expect(read("second", opened.sessionId)).rejects.toThrow("no saved output")
      } finally {
        startup.mockRestore()
        await project.close()
      }
      expect(await boxes()).toEqual([])
      const reopened = await fixedReaderProject(root, projectId, image)
      try {
        const expected = await expectedWindow("misc1", 1)
        for (const stream of ["stdout", "stderr"] as const) {
          const log = await reopened.evidence.fixedAttachmentLog(
            stopped.runId,
            stopped.sessionId,
            stream,
            { limitBytes: 32768 },
          )
          const bytes = Buffer.from(log.content, "base64")
          expect(log.session).toEqual(stopped)
          expect(log.byteLength).toBe(expected[stream].bytes)
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected[stream].sha256)
        }
        expect(await boxes()).toEqual([])
      } finally {
        await reopened.close()
      }
    }, 120_000)

    it("retains an interrupted reservation after losing the startup receipt and never restarts it", async () => {
      const project = await fixedReaderProject(root, projectId, image)
      let interrupted!: ToolReceipt
      let observedPid: number | undefined
      const loseReceipt = vi
        .spyOn(FixedAttachmentReadStore.prototype, "acknowledge")
        .mockImplementationOnce((_runId, _sessionId, pid) => {
          observedPid = pid
          throw new Error("injected lost startup receipt")
        })
      try {
        const solver = await project.createSolver("misc2", { agent: noModel() })
        const read = fixedTool(solver)
        await expect(read("open")).rejects.toThrow("injected lost startup receipt")
        expect(observedPid).toBeGreaterThan(0)
        interrupted = await read("open")
        expect(interrupted).toMatchObject({
          state: "interrupted",
          windows: 0,
          pid: null,
          exitCode: null,
        })
        expect(loseReceipt).toHaveBeenCalledOnce()
        expect(await read("finish", interrupted.sessionId)).toEqual(interrupted)
        await expect(read("first", interrupted.sessionId)).rejects.toThrow("no saved output")
      } finally {
        loseReceipt.mockRestore()
        await project.close()
      }
      const reopened = await fixedReaderProject(root, projectId, image)
      try {
        expect(await boxes()).toEqual([])
        const log = await reopened.evidence.fixedAttachmentLog(
          interrupted.runId,
          interrupted.sessionId,
          "stdout",
          {},
        )
        expect(log.session).toEqual(interrupted)
        expect(log.byteLength).toBe(0)
      } finally {
        await reopened.close()
      }
    }, 120_000)

    it("lets the Solver take over a child read and isolates a sibling, a concurrent Run and a later Run on the same ZIP", async () => {
      const project = await fixedReaderProject(root, projectId, image)
      const faux = createFauxCore({ provider: "fixed-reader-handoff" })
      const options = {
        agent: {
          streamFn: faux.streamSimple as AgentOptions["streamFn"],
          initialState: { model: faux.getModel() },
        },
      }
      try {
        const solver = await project.createSolver("misc1", options)
        const reader = fixedTool(solver)
        const altered = await archive("misc1")
        altered[altered.length - 1] = altered[altered.length - 1]! ^ 1
        expect(matchFixedAttachment(altered)).toBeUndefined()
        const delegate = solver.tools.find((tool) => tool.name === "Agent")!
        let first!: ToolReceipt
        const call = (action: string, id: string, sessionId?: string) =>
          fauxAssistantMessage(
            fauxToolCall(
              "fixed_attachment_read",
              { action, ...(sessionId && { sessionId }) },
              { id },
            ),
            { stopReason: "toolUse" },
          )
        faux.setResponses([
          call("open", "open"),
          (ctx) => call("first", "first", JSON.parse(observed(ctx, "open").text).sessionId),
          (ctx) => {
            first = JSON.parse(observed(ctx, "first").text)
            return fauxAssistantMessage("First window recorded.")
          },
        ])
        const task = {
          subagent_type: "general-purpose",
          description: "fixed read",
          prompt: "Read the first fixed window.",
          run_in_background: false,
        }
        await delegate.execute("child", task)
        expect(first).toMatchObject({
          owner: project.subagents(solver.runId)[0]!.id,
          runId: solver.runId,
          state: "reading",
          windows: 1,
          exitCode: null,
          output: await expectedWindow("misc1", 1),
        })
        const { sessionId } = first
        await expect(
          solver.tools
            .find((tool) => tool.name === "fixed_attachment_read")!
            .execute("forged", {
              action: "second",
              sessionId,
              owner: "solver",
              runId: first.runId,
            }),
        ).rejects.toThrow("Invalid fixed attachment request")
        let siblingDenied = false
        faux.setResponses([
          call("second", "sibling-second", sessionId),
          (ctx) => {
            const response = observed(ctx, "sibling-second")
            siblingDenied = response.failed && response.text.includes("not found in this scope")
            return fauxAssistantMessage("Sibling request observed.")
          },
        ])
        await delegate.execute("sibling", task)
        expect(siblingDenied).toBe(true)
        const other = await project.createSolver("misc2", options)
        const otherReader = fixedTool(other)
        for (const action of ["status", "first", "second", "finish"])
          await expect(otherReader(action, sessionId)).rejects.toThrow("not found in this scope")
        expect(await otherReader("list")).toEqual({ sessions: [] })
        const [own, duplicate] = await Promise.all([otherReader("open"), otherReader("open")])
        expect(duplicate).toEqual(own)
        expect(own.sessionId).not.toBe(sessionId)
        await expect(otherReader("second", own.sessionId)).rejects.toThrow("first window")
        const otherFirst = await otherReader("first", own.sessionId)
        const otherSecond = await otherReader("second", own.sessionId)
        expect(otherFirst.output).toEqual(await expectedWindow("misc2", 1))
        expect(otherSecond.output).toEqual(await expectedWindow("misc2", 2))
        expect(await otherReader("finish", own.sessionId)).toMatchObject({
          state: "exited",
          exitCode: 0,
        })
        let take!: ToolReceipt
        faux.setResponses([
          call("list", "parent-reads"),
          (ctx) => {
            const { sessions } = JSON.parse(observed(ctx, "parent-reads").text)
            expect(sessions).toMatchObject([{ sessionId, owner: first.owner }])
            return call("second", "takeover", sessions[0].sessionId)
          },
          (ctx) => {
            take = JSON.parse(observed(ctx, "takeover").text)
            return fauxAssistantMessage("Second window recorded.")
          },
        ])
        await solver.prompt(
          "List the fixed attachment readers and read the second window of the child reader.",
        )
        await solver.waitForIdle()
        expect(take).toMatchObject({
          owner: first.owner,
          pid: first.pid,
          windows: 2,
          output: await expectedWindow("misc1", 2),
        })
        expect(await reader("second", sessionId)).toEqual(take)
        const end = await reader("finish", sessionId)
        expect(end).toMatchObject({
          owner: first.owner,
          state: "exited",
          exitCode: 0,
          pid: first.pid,
        })
        expect(await reader("finish", sessionId)).toEqual(end)
        await solver.close("manual")
        const retry = await project.createSolver("misc1", options)
        await expect(fixedTool(retry)("first", sessionId)).rejects.toThrow(
          "not found in this scope",
        )
        expect(faux.state.callCount).toBe(8)
        console.info(
          "fixed-reader handoff",
          JSON.stringify({
            runId: solver.runId,
            otherRunId: other.runId,
            first,
            take,
            end,
            otherFirst,
            otherSecond,
            siblingDenied,
            crossRunDenied: 5,
          }),
        )
      } finally {
        await project.close()
      }
    }, 120_000)

    it("closes the other fixed reader and its container when one EOF receipt fails", async () => {
      const project = await fixedReaderProject(root, projectId, image)
      const faux = createFauxCore({ provider: "fixed-reader-cleanup" })
      const agent = {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel() },
      }
      let parent!: ToolReceipt
      let child!: ToolReceipt
      try {
        const solver = await project.createSolver("misc2", { agent })
        const read = fixedTool(solver)
        parent = await read("open")
        await read("first", parent.sessionId)
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall("fixed_attachment_read", { action: "open" }, { id: "child-open" }),
            { stopReason: "toolUse" },
          ),
          (ctx) => {
            child = JSON.parse(observed(ctx, "child-open").text)
            return fauxAssistantMessage("Reader ready.")
          },
        ])
        await solver.tools
          .find((tool) => tool.name === "Agent")!
          .execute("delegate", {
            subagent_type: "general-purpose",
            description: "open fixed reader",
            prompt: "Open the pinned attachment.",
            run_in_background: false,
          })
        await read("first", child.sessionId)
        expect(child.pid).not.toBe(parent.pid)
        const finish = vi
          .spyOn(FixedAttachmentReader.prototype, "finish")
          .mockRejectedValueOnce(new Error("injected missing EOF receipt"))
        try {
          await expect(solver.close("failed", "original fixture failure")).rejects.toBeInstanceOf(
            AggregateError,
          )
          expect(finish).toHaveBeenCalledTimes(2)
        } finally {
          finish.mockRestore()
        }
        expect(await boxes()).toEqual([])
        expect(project.runs()[0]).toMatchObject({
          error: "original fixture failure",
          cleanupError: expect.stringContaining("injected missing EOF receipt"),
        })
      } finally {
        await project.close()
      }
      const reopened = await fixedReaderProject(root, projectId, image)
      try {
        const read = fixedTool(await reopened.resumeSolver(parent.runId, { agent }))
        const lost = await read("status", parent.sessionId)
        const known = await read("status", child.sessionId)
        expect(lost).toMatchObject({ state: "interrupted", windows: 1, exitCode: null })
        expect(known).toMatchObject({ state: "exited", windows: 1, exitCode: 0 })
        for (const item of [parent, child])
          expect((await read("first", item.sessionId)).output).toEqual(
            await expectedWindow("misc2", 1),
          )
        console.info(
          "fixed-reader cleanup",
          JSON.stringify({ lost, known, originalFailurePreserved: true, containersAfterClose: 0 }),
        )
      } finally {
        await reopened.close()
      }
    }, 120_000)

    it("recovers acknowledged bytes and distinguishes a confirmed exit from an interrupted reader after host death", async () => {
      const owner = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          fileURLToPath(new URL("./fixtures/fixed-reader-owner.ts", import.meta.url)),
          root,
          projectId,
          image,
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 90_000 },
      )
      let stderr = ""
      owner.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const [code, signal] = await once(owner, "close")
      const records: { first: ToolReceipt; last: ToolReceipt }[] = JSON.parse(
        await readFile(join(root, "fixed-owner.json"), "utf8").catch(() => {
          throw new Error("Fixed reader owner did not finish setup: " + stderr)
        }),
      )
      expect(signal === "SIGKILL" || (process.platform === "win32" && code === 1)).toBe(true)
      expect(await boxes()).toHaveLength(2)
      const model = createFauxCore({ provider: "offline-fixed-reads" }).getModel()
      for (let reopen = 0; reopen < 2; reopen++) {
        const project = await fixedReaderProject(root, projectId, image)
        try {
          expect(await boxes()).toEqual([])
          for (const { first, last } of records) {
            const retained = await project.evidence.fixedAttachmentLog(
              first.runId,
              first.sessionId,
              "stderr",
              {},
            )
            expect(retained.session).toMatchObject({
              state: first.sample === "misc1" ? "exited" : "interrupted",
              exitCode: first.sample === "misc1" ? 0 : null,
              windows: 1,
            })
            expect(
              createHash("sha256").update(Buffer.from(retained.content, "base64")).digest("hex"),
            ).toBe((await expectedWindow(first.sample, 1)).stderr.sha256)
            const solver = await project.resumeSolver(first.runId, {
              agent: {
                initialState: { model },
                streamFn: () => {
                  throw new Error("Unexpected model request")
                },
              },
            })
            const tool = fixedTool(solver)
            const { sample, sessionId } = first
            const status = await tool("status", sessionId)
            expect(status).toMatchObject({
              sessionId,
              pid: first.pid,
              state: sample === "misc1" ? "exited" : "interrupted",
              exitCode: sample === "misc1" ? 0 : null,
              windows: 1,
            })
            if (sample === "misc1") expect(status).toEqual(last)
            expect(await tool("open")).toEqual(status)
            expect((await tool("first", sessionId)).output).toEqual(await expectedWindow(sample, 1))
            await expect(tool("second", sessionId)).rejects.toThrow("no saved output")
            expect(await tool("finish", sessionId)).toEqual(status)
            console.info(
              "fixed-reader recovery",
              JSON.stringify({ reopen, before: last, after: status }),
            )
            await solver.close("manual")
          }
        } finally {
          await project.close()
        }
      }
    }, 180_000)
  },
)
