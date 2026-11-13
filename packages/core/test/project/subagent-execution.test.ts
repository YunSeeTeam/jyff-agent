import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CtfSubagent,
  discoverSubagentRoles,
  type BaseAgentEvent,
  type Sandbox,
} from "@ctf-agent/agents"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  CtfSubagentManager,
  createSubagentManagerTools,
  type SubagentManagerOptions,
  type SubagentLifecyclePersistence,
} from "../../src/collaboration/subagent-manager.ts"
import {
  firstSubagentResultPage,
  subagentResultPage,
} from "../../src/collaboration/subagent-report.ts"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const input = {
  role: "general-purpose",
  prompt: "test task",
  description: "test execution",
  background: true,
}
const sandbox: Sandbox = {
  id: "memory",
  async exec(args) {
    return {
      code: 0,
      stdout: args[0] === "python3" ? JSON.stringify({ ok: true, value: null }) : "",
      stderr: "",
    }
  },
  async close() {},
}

async function fixture(extra: Partial<SubagentManagerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "subagent-execution-"))
  roots.push(root)
  const faux = createFauxCore({ provider: "execution-test" })
  const discovered = await discoverSubagentRoles(root)
  const manager = new CtfSubagentManager({
    projectId: "test",
    runId: "run",
    runDirectory: root,
    challenge: {
      id: "challenge",
      title: "test",
      category: "misc",
      score: 100,
      description: "test",
      attachments: [],
    },
    sandbox,
    roles: discovered.roles,
    agent: {
      streamFn: faux.streamSimple as AgentOptions["streamFn"],
      initialState: { model: faux.getModel(), thinkingLevel: "off" },
    },
    fullSubagentReports: true,
    ...extra,
  })
  return { manager, faux }
}

function passthrough(): SubagentLifecyclePersistence {
  return {
    beginExecution: (record) => ({ ...record }),
    commitResult: (record) => ({ ...record }),
    recordProgress() {},
  }
}

describe("durable SubAgent executions", () => {
  it("publishes a committed result even when lifecycle telemetry throws synchronously", async () => {
    const { manager, faux } = await fixture({
      onRecord: () => {
        throw new Error("telemetry offline")
      },
    })
    faux.setResponses([fauxAssistantMessage("saved")])
    const created = manager.spawn(input)
    await expect(manager.wait(created.id)).resolves.toMatchObject({
      status: "completed",
      result: "saved",
    })
    await manager.close()
  })

  it("cancel racing with normal completion keeps a partial source (T14)", async () => {
    let manager!: CtfSubagentManager
    let cancellation: Promise<unknown> | undefined
    const built = await fixture({
      onAgentEvent: (record, event) => {
        if (event.type === "message_end" && event.message.role === "assistant")
          cancellation = manager.cancel(record.id)
      },
    })
    manager = built.manager
    built.faux.setResponses([fauxAssistantMessage("last observation")])
    const created = manager.spawn(input)
    const done = await manager.wait(created.id)
    await cancellation
    expect(done).toMatchObject({
      status: "cancelled",
      resultKind: "assistant_partial",
      result: "last observation",
    })
    await manager.close()
  })

  it.each(["boundary", "limit"])(
    "cancels and rejects waits when report capture fails: %s",
    async (failure) => {
      let agent!: CtfSubagent
      const create = CtfSubagent.create.bind(CtfSubagent)
      vi.spyOn(CtfSubagent, "create").mockImplementation(async (options) => {
        agent = await create(options)
        return agent
      })
      let started!: () => void
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const { manager, faux } = await fixture()
      faux.setResponses([
        async (_context, options) => {
          started()
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve()
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          return fauxAssistantMessage("late reply")
        },
      ])
      const created = manager.spawn(input)
      await ready
      if (failure === "boundary")
        vi.spyOn(agent.sessionManager, "getEntry").mockReturnValue(undefined)
      else agent.sessionManager.appendMessage(fauxAssistantMessage("x".repeat(4 * 1024 * 1024 + 1)))
      const code = failure === "boundary" ? "result_boundary_unavailable" : "report_storage_limit"
      const waiting = expect(manager.wait(created.id)).rejects.toMatchObject({ code })
      await expect(manager.cancel(created.id)).rejects.toMatchObject({ code })
      await waiting
      expect(manager.get(created.id)).toMatchObject({ status: "cancelled" })
      expect(manager.get(created.id)?.result).toBeUndefined()
      await manager.close()
    },
  )

  it("persists a full report with a tail sentinel and paginates exactly (T11)", async () => {
    const { manager, faux } = await fixture()
    const text = "😀字".repeat(6500) + "tail-sentinel"
    faux.setResponses([fauxAssistantMessage(text)])
    const created = manager.spawn(input)
    const done = await manager.wait(created.id)
    expect(done.result).toBe(text)
    expect(done.resultKind).toBe("assistant_final")
    let page = firstSubagentResultPage(done)
    let collected = page.result
    while (page.nextOffset !== undefined) {
      const next = subagentResultPage(done, {
        offset: page.nextOffset,
        expectedResultVersion: page.resultVersion,
      })
      if ("error" in next) throw new Error(next.error.code)
      page = next
      collected += page.result
    }
    expect(collected).toBe(text)
    await manager.close()
  })

  it("same-text resume gets a new version and ignores old subscribed callbacks (T13)", async () => {
    const callbacks: Array<(event: BaseAgentEvent) => void> = []
    const create = CtfSubagent.create.bind(CtfSubagent)
    vi.spyOn(CtfSubagent, "create").mockImplementation(async (options) => {
      const agent = await create(options)
      const subscribe = agent.subscribe.bind(agent)
      vi.spyOn(agent, "subscribe").mockImplementation((listener) => {
        callbacks.push(listener)
        return subscribe(listener)
      })
      return agent
    })
    const { manager, faux } = await fixture()
    faux.setResponses([fauxAssistantMessage("same"), fauxAssistantMessage("same")])
    const created = manager.spawn(input)
    const first = await manager.wait(created.id)
    const second = await manager.resume(created.id, "repeat", false)
    expect(second.executionId).not.toBe(first.executionId)
    expect(firstSubagentResultPage(second).resultVersion).not.toBe(
      firstSubagentResultPage(first).resultVersion,
    )
    const before = manager.get(created.id)
    callbacks[0]!({ type: "message_end", message: fauxAssistantMessage("late") })
    expect(manager.get(created.id)).toEqual(before)
    await manager.close()
  })

  it.each(["error", "aborted"] as const)(
    "maps resolved Pi %s to a partial report (T15)",
    async (stopReason) => {
      const { manager, faux } = await fixture()
      faux.setResponses([
        fauxAssistantMessage("partial observation", { stopReason, errorMessage: "stopped" }),
      ])
      const created = manager.spawn(input)
      const done = await manager.wait(created.id)
      expect(done.status).toBe(stopReason === "error" ? "failed" : "aborted")
      expect(done.resultKind).toBe("assistant_partial")
      expect(done.result).toBe("partial observation")
      await manager.close()
    },
  )

  it("begin failure returns before any session/model is started", async () => {
    const persistence = passthrough()
    persistence.beginExecution = () => {
      throw new Error("disk offline")
    }
    const create = vi.spyOn(CtfSubagent, "create")
    const { manager } = await fixture({ persistence })
    expect(() => manager.spawn(input)).toThrow("disk offline")
    expect(manager.list()).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects waits on report commit failure and never exposes uncommitted text (T16)", async () => {
    const persistence = passthrough()
    persistence.commitResult = () => {
      throw new Error("disk offline")
    }
    const events: string[] = []
    const { manager, faux } = await fixture({
      persistence,
      onRecord: (_record, event) => {
        events.push(event)
      },
    })
    faux.setResponses([fauxAssistantMessage("must not publish")])
    const created = manager.spawn(input)
    await expect(manager.wait(created.id)).rejects.toMatchObject({
      code: "report_persistence_failed",
    })
    expect(manager.list()[0]).toMatchObject({ status: "running" })
    expect(manager.list()[0]?.result).toBeUndefined()
    expect(() => manager.get(created.id)).toThrow(
      expect.objectContaining({ code: "report_persistence_failed" }),
    )
    expect(events).not.toContain("completed")
    await expect(manager.resume(created.id, "retry", false)).rejects.toThrow()
    const tool = createSubagentManagerTools(manager).find(
      (tool) => tool.name === "get_subagent_result",
    )!
    const result = await tool.execute(
      "wait",
      { agent_id: created.id, wait: true },
      new AbortController().signal,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("report_persistence_failed"),
    })
    await manager.close()
  })

  it("rejects storage overflow without silently truncating or completing (T16)", async () => {
    const { manager, faux } = await fixture()
    faux.setResponses([fauxAssistantMessage("x".repeat(4 * 1024 * 1024 + 1))])
    const created = manager.spawn(input)
    await expect(manager.wait(created.id)).rejects.toMatchObject({ code: "report_storage_limit" })
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("4 MiB"),
    })
    expect(manager.get(created.id)?.result).toBeUndefined()
    await manager.close()
  })
})
