import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BaseAgentEvent,
  type ChallengeInfo,
  type CtfSolverAgent,
  discoverSubagentRoles,
  type Sandbox,
} from "@ctf-agent/agents"
import type { CommandResult, SandboxExecOptions } from "@ctf-agent/sandbox"
import type { AgentOptions, AgentToolResult } from "@earendil-works/pi-agent-core"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { Type } from "typebox"
import { afterEach, describe, expect, it } from "vite-plus/test"
import {
  CtfSubagentManager,
  createSubagentManagerTools,
  type SubagentLifecycleEvent,
} from "../../src/collaboration/subagent-manager.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class MemorySandbox implements Sandbox {
  readonly id = "shared-container"
  readonly createdDirectories: string[] = []

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    if (args[0] === "python3") {
      const payload = JSON.parse(options?.input ?? "{}") as {
        op?: string
        path?: string
      }
      if (payload.op === "mkdir" && payload.path) {
        this.createdDirectories.push(payload.path)
      }
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, value: null }),
        stderr: "",
      }
    }
    return { code: 0, stdout: "", stderr: "" }
  }

  async close(): Promise<void> {}
}

const challenge: ChallengeInfo = {
  id: "pwn-1",
  title: "Heap Garden",
  category: "pwn",
  score: 500,
  description: "find the primitive",
  attachments: [],
}

describe("CtfSubagentManager", () => {
  it("后台完成后立即 steer 结构化通知给主 Solver", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-notify-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-notify" })
    faux.setResponses([fauxAssistantMessage("verified offset < 0x40")])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-notify",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    manager.attachParent(parent.agent)

    const created = manager.spawn({
      role: "general-purpose",
      prompt: "verify the offset",
      description: "offset check",
      background: true,
    })
    await manager.wait(created.id)
    await waitFor(() => parent.steered.length === 1)

    expect(parent.steered[0]).toContain("<subagent_notification>")
    expect(parent.steered[0]).toContain(`<id>${created.id}</id>`)
    expect(parent.steered[0]).toContain("verified offset &lt; 0x40")
    expect(parent.followedUp).toEqual([])
    await manager.close()
  })

  it("单结果出口保留旧 8000 前缀尾部的候选，封套有界且不带 prompt（T18）", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-prefix-"))
    roots.push(root)
    const report = `${"界".repeat(7_980)}FLAG{tail-candidate}`
    expect(report.length).toBe(8_000)
    const faux = createFauxCore({ provider: "subagent-prefix" })
    faux.setResponses([fauxAssistantMessage(report)])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-prefix",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    manager.attachParent(parent.agent)
    const tools = createSubagentManagerTools(manager)
    const launch = tools.find((tool) => tool.name === "Agent")
    const get = tools.find((tool) => tool.name === "get_subagent_result")
    if (!launch || !get) throw new Error("SubAgent 工具未创建")
    const prompt = `${"P".repeat(31_990)}END-PROMPT`

    const launched = await launch.execute("launch", {
      subagent_type: "general-purpose",
      prompt,
      description: "prefix check",
      run_in_background: true,
    })
    const id = launched.details.id
    if (typeof id !== "string") throw new Error("SubAgent ID 缺失")
    expect(textOf(launched)).not.toContain("END-PROMPT")
    await manager.wait(id)
    await waitFor(() => parent.steered.length === 1)

    const notification = parent.steered[0] ?? ""
    expect(notification).toContain("FLAG{tail-candidate}")
    expect(notification).not.toContain("<next_offset>")
    expect(Buffer.byteLength(notification)).toBeLessThanOrEqual(96 * 1024)

    const read = await get.execute("read", { agent_id: id })
    const body = textOf(read)
    expect(JSON.parse(body)).toMatchObject({
      agentId: id,
      status: "completed",
      result: report,
      hasMore: false,
    })
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(96 * 1024)
    expect(body).not.toContain("END-PROMPT")
    // details are kept in the session and shown by the WebUI: identifiers and counts only.
    expect(JSON.stringify(read.details)).not.toContain("界")
    expect(read.details).toMatchObject({ id, totalLength: 8_000, hasMore: false })

    const refused = await get.execute("refused", { agent_id: id, offset: 10 })
    expect(refused.isError).toBe(true)
    expect(JSON.parse(textOf(refused))).toMatchObject({ error: { code: "invalid_query" } })
    await manager.close()
  })

  it("list_subagents 按页枚举全部子任务，每页不超过 16 KiB（T19）", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-list-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-list" })
    faux.setResponses(
      Array.from({ length: 40 }, (_, index) =>
        fauxAssistantMessage(`${index}:${"報".repeat(7_000)}`),
      ),
    )
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-list",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    const created = []
    for (let index = 0; index < 40; index++) {
      created.push(
        manager.spawn({
          role: "general-purpose",
          prompt: `${"Q".repeat(31_000)} worker ${index}`,
          description: `${"任".repeat(240)}`,
          background: true,
        }),
      )
      // Distinct creation times keep the expected order unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await Promise.all(created.map((record) => manager.wait(record.id)))
    const list = createSubagentManagerTools(manager).find((tool) => tool.name === "list_subagents")
    if (!list) throw new Error("list_subagents 未创建")

    const seen: string[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < 100; pages++) {
      const result = await list.execute(`list-${pages}`, cursor ? { cursor } : {})
      const body = textOf(result)
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024)
      expect(body).not.toContain("QQQQ")
      const page = JSON.parse(body) as { items: Array<{ id: string }>; nextCursor?: string }
      expect(page.items.length).toBeGreaterThan(0)
      expect(result.details.ids).toEqual(page.items.map((item) => item.id))
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(created.map((record) => record.id))
    await manager.close()
  })

  it("wait 模式在父 Solver 收到 steer 时中断但不取消 worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-wait-steer-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-wait-steer" })
    let finishWorker!: () => void
    const workerGate = new Promise<void>((resolve) => {
      finishWorker = resolve
    })
    faux.setResponses([
      async () => {
        await workerGate
        return fauxAssistantMessage("worker eventually finished")
      },
    ])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-wait-steer",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    manager.attachParent(parent.agent)
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "long investigation",
      description: "long worker",
      background: true,
    })
    await waitFor(() => manager.get(created.id)?.status === "running")

    const waiting = manager.waitForTool(created.id)
    let uninterruptedSettled = false
    const uninterrupted = manager.waitForTool(created.id, undefined, false).finally(() => {
      uninterruptedSettled = true
    })
    parent.queueSteer()
    await expect(waiting).resolves.toMatchObject({
      waitInterrupted: true,
      record: { id: created.id, status: "running" },
    })
    expect(manager.get(created.id)?.status).toBe("running")
    await Promise.resolve()
    expect(uninterruptedSettled).toBe(false)

    finishWorker()
    await expect(uninterrupted).resolves.toMatchObject({
      waitInterrupted: false,
      record: {
        status: "completed",
        result: "worker eventually finished",
      },
    })
    await manager.close()
  })

  it("以前台任务返回结果，并保留稳定 worker 记录和生命周期", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-manager-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-test" })
    faux.setResponses([
      fauxAssistantMessage("verified heap leak at offset 0x20"),
      fauxAssistantMessage("follow-up confirmed libc offset"),
    ])
    const sandbox = new MemorySandbox()
    const discovered = await discoverSubagentRoles(root)
    const events: SubagentLifecycleEvent[] = []
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-1",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      onRecord: (_record, event) => {
        events.push(event)
      },
    })

    const created = manager.spawn({
      role: "general-purpose",
      prompt: "verify the leak",
      description: "leak check",
      background: false,
    })
    const result = await manager.wait(created.id)

    expect(result).toMatchObject({
      id: created.id,
      runId: "run-1",
      role: "general-purpose",
      status: "completed",
      result: "verified heap leak at offset 0x20",
      background: false,
    })
    expect(result.containerCwd).toBe(`/workspace/subagents/${created.id}`)
    expect(sandbox.createdDirectories).toContain(result.containerCwd)
    expect(events).toEqual(expect.arrayContaining(["created", "started", "completed"]))
    expect(manager.list()).toHaveLength(1)

    const steered = await manager.steer(created.id, "verify the follow-up")
    expect(steered).toMatchObject({
      id: created.id,
      status: "queued",
      background: true,
    })
    const resumed = await manager.wait(created.id)
    expect(resumed).toMatchObject({
      id: created.id,
      status: "completed",
      result: "follow-up confirmed libc offset",
    })
    expect(manager.list()).toHaveLength(1)
    await manager.close()
  })

  it("可从重启后 interrupted 记录恢复 JSONL 会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-restore-"))
    roots.push(root)
    const discovered = await discoverSubagentRoles(root)
    const sandbox = new MemorySandbox()
    const firstCore = createFauxCore({ provider: "subagent-restore" })
    firstCore.setResponses([fauxAssistantMessage("first investigation")])
    const first = new CtfSubagentManager({
      projectId: "test",
      runId: "run-restore",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: firstCore.streamSimple as AgentOptions["streamFn"],
        initialState: { model: firstCore.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    const created = first.spawn({
      role: "general-purpose",
      prompt: "inspect the binary",
      description: "initial inspection",
      background: false,
    })
    const completed = await first.wait(created.id)
    await first.close()

    const resumedCore = createFauxCore({ provider: "subagent-restore" })
    resumedCore.setResponses([fauxAssistantMessage("continued from JSONL")])
    const resumed = new CtfSubagentManager({
      projectId: "test",
      runId: "run-restore",
      runDirectory: root,
      challenge,
      sandbox,
      agent: {
        streamFn: resumedCore.streamSimple as AgentOptions["streamFn"],
        initialState: { model: resumedCore.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })
    resumed.restore([completed])

    const steered = await resumed.steer(created.id, "continue the investigation")
    expect(steered).toMatchObject({
      id: created.id,
      status: "queued",
      background: true,
      sessionPath: completed.sessionPath,
    })
    const result = await resumed.wait(created.id)
    expect(result).toMatchObject({
      id: created.id,
      status: "completed",
      result: "continued from JSONL",
      sessionPath: completed.sessionPath,
    })
    await resumed.close()
  })

  it("暴露兼容工具名，并拒绝不存在的角色", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-tools-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-tools" })
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-2",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
    })

    expect(createSubagentManagerTools(manager).map((tool) => tool.name)).toEqual([
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "cancel_subagent",
      "list_subagents",
    ])
    expect(() =>
      manager.spawn({
        role: "pw",
        prompt: "invalid",
        description: "invalid",
        background: true,
      }),
    ).toThrow("未知或已禁用")
    await manager.close()
  })

  it("在异步会话初始化前预占后台槽位，严格执行并发上限", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-queue-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-queue" })
    let active = 0
    let maximum = 0
    faux.setResponses(
      [1, 2, 3].map((index) => async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 0))
        active--
        return fauxAssistantMessage(`worker ${index} done`)
      }),
    )
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-queue",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      maxConcurrent: 1,
    })
    const records = [1, 2, 3].map((index) =>
      manager.spawn({
        role: "general-purpose",
        prompt: `task ${index}`,
        description: `worker ${index}`,
        background: true,
      }),
    )

    expect(manager.get(records[1]?.id ?? "")?.status).toBe("queued")
    expect(manager.get(records[2]?.id ?? "")?.status).toBe("queued")
    const results = await Promise.all(records.map((record) => manager.wait(record.id)))
    expect(results.map((record) => record.status)).toEqual(["completed", "completed", "completed"])
    expect(maximum).toBe(1)
    await manager.close()
  })

  it("blocking 收尾等待运行 worker 完成并取消尚未启动的任务", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-finalize-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-finalize" })
    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return fauxAssistantMessage("initial work")
      },
      fauxAssistantMessage("complete final report"),
    ])
    const discovered = await discoverSubagentRoles(root)
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-finalize",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      maxConcurrent: 1,
    })
    const running = manager.spawn({
      role: "general-purpose",
      prompt: "investigate",
      description: "running worker",
      background: true,
    })
    await waitFor(() => manager.get(running.id)?.status === "running")
    const queued = manager.spawn({
      role: "general-purpose",
      prompt: "queued investigation",
      description: "queued worker",
      background: true,
    })

    const records = await manager.finalize("Produce the final report now.", 500)

    expect(records.find((record) => record.id === running.id)).toMatchObject({
      status: "completed",
      result: "complete final report",
    })
    expect(records.find((record) => record.id === queued.id)).toMatchObject({
      status: "cancelled",
    })
    expect(records.every((record) => record.status !== "running")).toBe(true)
    expect(() =>
      manager.spawn({
        role: "general-purpose",
        prompt: "too late",
        description: "late worker",
        background: true,
      }),
    ).toThrow("正在收尾")
    await manager.close()
  })

  it("获胜回收保留运行 worker 的最近工具结果，取消余项且不注入取消通知", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-subagent-winner-cleanup-"))
    roots.push(root)
    const faux = createFauxCore({ provider: "subagent-winner-cleanup" })
    let secondTurnStarted!: () => void
    const secondTurn = new Promise<void>((resolve) => {
      secondTurnStarted = resolve
    })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("report_candidate", {}, { id: "candidate" }), {
        stopReason: "toolUse",
      }),
      async (_context, options) => {
        secondTurnStarted()
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve()
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return fauxAssistantMessage("late polished report")
      },
    ])
    const discovered = await discoverSubagentRoles(root)
    const parent = fakeParent()
    const manager = new CtfSubagentManager({
      projectId: "test",
      runId: "run-winner-cleanup",
      runDirectory: root,
      challenge,
      sandbox: new MemorySandbox(),
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" },
      },
      roles: discovered.roles,
      webAccessTools: [
        {
          name: "report_candidate",
          label: "Report Candidate",
          description: "Return a deterministic candidate for the lifecycle test.",
          parameters: Type.Object({}),
          async execute() {
            return {
              content: [{ type: "text", text: "FLAG{winner}" }],
              details: { candidate: "FLAG{winner}" },
            }
          },
        },
      ],
    })
    manager.attachParent(parent.agent)
    const created = manager.spawn({
      role: "general-purpose",
      prompt: "find a candidate flag",
      description: "candidate search",
      background: true,
    })
    await secondTurn

    const firstClose = manager.close()
    const repeatedClose = manager.close()
    await Promise.all([firstClose, repeatedClose])

    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      result: expect.stringContaining("FLAG{winner}"),
    })
    expect(parent.steered).toEqual([])
    expect(() =>
      manager.spawn({
        role: "general-purpose",
        prompt: "too late",
        description: "late worker",
        background: true,
      }),
    ).toThrow("正在收尾或关闭")
  })
})

function textOf(result: AgentToolResult<unknown>): string {
  const [first] = result.content
  return first?.type === "text" ? first.text : ""
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 SubAgent 状态超时")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function fakeParent(): {
  agent: CtfSolverAgent
  steered: string[]
  followedUp: string[]
  queueSteer(): void
} {
  const steered: string[] = []
  const followedUp: string[] = []
  const listeners = new Set<(event: BaseAgentEvent) => void>()
  let queued = false
  const parent = {
    isClosed: false,
    hasQueuedSteerMessages: () => queued,
    subscribe(listener: (event: BaseAgentEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async steer(message: string) {
      steered.push(message)
    },
    async promptOrSteer(message: string) {
      steered.push(message)
    },
    async followUp(message: string) {
      followedUp.push(message)
    },
  }
  return {
    agent: parent as unknown as CtfSolverAgent,
    steered,
    followedUp,
    queueSteer() {
      queued = true
      for (const listener of listeners) {
        listener({
          type: "queue_update",
          steer: ["notice"],
          followUp: [],
          nextTurn: [],
        })
      }
    },
  }
}
