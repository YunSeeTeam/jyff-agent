import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentOptions, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  BaseAgent,
  type BaseAgentEvent,
  type BaseAgentOptions,
  type CompactResult,
  DEFAULT_SOLVER_THINKING_LEVEL,
  modelsFromAgentOptions,
  prepareBaseAgent,
} from "../../src/index.ts"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `base-agent-${prefix}-`))
  roots.push(root)
  return root
}

it("uses medium as the product default for Solver reasoning", () => {
  expect(DEFAULT_SOLVER_THINKING_LEVEL).toBe("medium")
})

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://invalid.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const legacy = {
  streamFn: (() => {
    throw new Error("model is not called by this test")
  }) as AgentOptions["streamFn"],
} satisfies AgentOptions

const noopTool: AgentTool = {
  name: "noop",
  label: "No-op",
  description: "No-op test tool",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: {} }
  },
}

class TestAgent extends BaseAgent {
  static async open(options: BaseAgentOptions) {
    return new TestAgent(await prepareBaseAgent(options), {
      compaction: options.compaction,
      compactionInstructions: options.compactionInstructions,
      compactionHooks: options.compactionHooks,
    })
  }

  mockCompact(result: CompactResult) {
    return vi.spyOn(this.piSession, "compact").mockResolvedValue(result)
  }
}

function fauxSetup() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 64_000 }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, models, model: faux.getModel() }
}

describe("BaseAgent native session", () => {
  it("restores transcript, model, thinking level, active tools, and tree entries", async () => {
    const root = await tempRoot("session")
    const session = { path: join(root, "session.jsonl"), id: "run-1", cwd: root }
    const models = modelsFromAgentOptions(legacy, model)
    const common = { session, models, model, tools: [noopTool], compaction: false }

    const first = await TestAgent.open({
      ...common,
      thinkingLevel: "low",
      initialMessages: [{ role: "user", content: "persist me", timestamp: 1 }],
    })
    first.sessionManager.appendMessage({ role: "user", content: "second message", timestamp: 2 })
    await first.setThinkingLevel("high")
    await first.setActiveTools([])
    const firstKept = first.sessionManager.getEntries()[0]?.id ?? null
    first.sessionManager.appendCompaction("summary", firstKept, 123)

    const restored = await TestAgent.open({ ...common, thinkingLevel: "off" })
    expect(restored.restored).toBe(true)
    expect(restored.sessionManager.getSessionId()).toBe("run-1")
    expect(restored.thinkingLevel).toBe("high" satisfies ThinkingLevel)
    expect(restored.model.id).toBe(model.id)
    expect(restored.tools.map((tool) => tool.name)).toEqual(["noop"])
    expect(restored.activeTools).toEqual([])
    const entries = restored.sessionManager.getEntries()
    expect(
      entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "second message",
      ),
    ).toBe(true)
    expect(entries.some((entry) => entry.type === "compaction")).toBe(true)
  })

  it("exposes context pressure without mutating the session", async () => {
    const root = await tempRoot("pressure")
    const agent = await TestAgent.open({
      session: { path: join(root, "session.jsonl"), id: "pressure-run", cwd: root },
      models: modelsFromAgentOptions(legacy, model),
      model,
      initialMessages: [{ role: "user", content: "short history", timestamp: 1 }],
      compaction: false,
    })

    const entriesBefore = agent.sessionManager.getEntries()
    const pressure = await agent.contextPressure()
    const entriesAfter = agent.sessionManager.getEntries()

    expect(pressure).toMatchObject({ contextWindow: model.contextWindow, shouldCompact: false })
    expect(pressure.tokens).toBeGreaterThan(0)
    expect(pressure.usableContext).toBe(pressure.contextWindow - pressure.reserveTokens)
    expect(entriesAfter).toEqual(entriesBefore)
  })

  it("restores only active tools the current tool set still allows", async () => {
    const root = await tempRoot("tool-restore")
    const extraTool: AgentTool = { ...noopTool, name: "extra", label: "Extra" }
    const common = {
      session: { path: join(root, "session.jsonl"), id: "run-tools", cwd: root },
      models: modelsFromAgentOptions(legacy, model),
      model,
      compaction: false,
    }
    const names = (agent: TestAgent) => agent.activeTools.map((tool) => tool.name)

    const first = await TestAgent.open({ ...common, tools: [noopTool, extraTool] })
    expect(names(first)).toEqual(["noop", "extra"])

    // The role whitelist no longer includes `extra`: it must not come back on restore.
    const narrowed = await TestAgent.open({ ...common, tools: [noopTool] })
    expect(names(narrowed)).toEqual(["noop"])

    // Widening the tool set again does not silently re-grant what the session lost.
    const widened = await TestAgent.open({ ...common, tools: [noopTool, extraTool] })
    expect(names(widened)).toEqual(["noop"])
  })

  it("keeps a phase-restricted tool set on restore", async () => {
    const root = await tempRoot("phase-restore")
    const extraTool: AgentTool = { ...noopTool, name: "extra", label: "Extra" }
    const common = {
      session: { path: join(root, "session.jsonl"), id: "run-phase", cwd: root },
      models: modelsFromAgentOptions(legacy, model),
      model,
      tools: [noopTool, extraTool],
      compaction: false,
    }

    const writeup = await TestAgent.open(common)
    await writeup.setActiveTools(["noop"])

    const restored = await TestAgent.open(common)
    expect(restored.activeTools.map((tool) => tool.name)).toEqual(["noop"])
  })

  it("runs compaction lifecycle hooks around the configured CTF instructions", async () => {
    const root = await tempRoot("compact-hook")
    const order: string[] = []
    const result: CompactResult = {
      summary: "summary",
      firstKeptEntryId: "entry",
      tokensBefore: 10,
    }
    const agent = await TestAgent.open({
      session: { path: join(root, "session.jsonl"), id: "compact-hook-run", cwd: root },
      models: modelsFromAgentOptions(legacy, model),
      model,
      compactionInstructions: "CTF compact instructions",
      compactionHooks: {
        before: () => {
          order.push("before")
        },
        after: () => {
          order.push("after")
        },
      },
    })
    const compact = agent.mockCompact(result)

    await expect(agent.compact()).resolves.toBe(result)
    expect(compact).toHaveBeenCalledWith("CTF compact instructions")
    expect(order).toEqual(["before", "after"])
  })

  it("does not attempt impossible default compaction for a small-context model", async () => {
    const root = await tempRoot("small-context")
    const smallModel = { ...model, id: "small", contextWindow: 1_024 }
    const agent = await TestAgent.open({
      session: { path: join(root, "session.jsonl"), id: "small-run", cwd: root },
      models: modelsFromAgentOptions(legacy, smallModel),
      model: smallModel,
      initialMessages: [{ role: "user", content: "short history", timestamp: 1 }],
    })

    const response = await agent.prompt("continue")
    expect(response.stopReason).toBe("error")
    expect(response.errorMessage).toBe("model is not called by this test")
  })
})

describe("BaseAgent resuming Pi 0.82 sessions", () => {
  it("restores model, thinking level, and the legacy tool loadout", async () => {
    const root = await tempRoot("legacy")
    const path = join(root, "session.jsonl")
    const extraTool: AgentTool = { ...noopTool, name: "extra", label: "Extra" }
    const entries = [
      {
        type: "session",
        version: 3,
        id: "legacy-run",
        timestamp: "2026-11-03T00:00:00.000Z",
        cwd: root,
        metadata: { agentType: "ctf-solver" },
      },
      {
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: "2026-11-03T00:00:01.000Z",
        message: { role: "user", content: "context", timestamp: 1 },
      },
      {
        type: "model_change",
        id: "e2",
        parentId: "e1",
        timestamp: "2026-11-03T00:00:02.000Z",
        provider: model.provider,
        modelId: model.id,
      },
      {
        type: "thinking_level_change",
        id: "e3",
        parentId: "e2",
        timestamp: "2026-11-03T00:00:03.000Z",
        thinkingLevel: "low",
      },
      {
        type: "active_tools_change",
        id: "e4",
        parentId: "e3",
        timestamp: "2026-11-03T00:00:04.000Z",
        activeToolNames: ["noop", "removed"],
      },
    ]
    await writeFile(
      path,
      entries.map((entry) => JSON.stringify(entry)).join(String.fromCharCode(10)),
    )

    const agent = await TestAgent.open({
      session: { path, id: "legacy-run", cwd: root },
      models: modelsFromAgentOptions(legacy, model),
      model,
      thinkingLevel: "high",
      tools: [noopTool, extraTool],
      compaction: false,
    })

    expect(agent.restored).toBe(true)
    expect(agent.model.id).toBe(model.id)
    expect(agent.thinkingLevel).toBe("low")
    expect(agent.activeTools.map((tool) => tool.name)).toEqual(["noop"])
    expect((await agent.getMessages()).map((message) => message.role)).toEqual(["user"])
  })
})

describe("BaseAgent on Pi AgentSession", () => {
  it("runs tool turns, returns the final reply, and hides prompt system messages", async () => {
    const root = await tempRoot("turns")
    const { faux, models, model: fauxModel } = fauxSetup()
    const echo: AgentTool = {
      name: "echo",
      label: "Echo",
      description: "Echo text",
      parameters: Type.Object({ text: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: `echo:${(params as { text: string }).text}` }],
          details: {},
        }
      },
    }
    const agent = await TestAgent.open({
      session: { path: join(root, "session.jsonl"), id: "turn-run", cwd: root },
      models,
      model: fauxModel,
      systemPrompt: "You solve test challenges.",
      // Pi lists skills only when a tool can read their files.
      tools: [echo, { ...noopTool, name: "read", label: "Read" }],
      skills: [
        {
          name: "reverse",
          description: "Reverse binaries",
          filePath: "/host/skills/reverse/SKILL.md",
          baseDir: "/host/skills/reverse",
          sandboxPath: "/workspace/.skills/skill-1/SKILL.md",
          sandboxBaseDir: "/workspace/.skills/skill-1",
        },
      ],
      compaction: false,
    })
    const events: BaseAgentEvent[] = []
    agent.subscribe((event) => {
      events.push(event)
    })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "hi" })),
      fauxAssistantMessage("done"),
    ])

    const reply = await agent.prompt("start")

    expect(reply.stopReason).toBe("stop")
    expect(reply.content).toEqual([{ type: "text", text: "done" }])
    expect(agent.systemPrompt).toContain("You solve test challenges.")
    expect(agent.systemPrompt).toContain("/workspace/.skills/skill-1/SKILL.md")
    expect(agent.systemPrompt).not.toContain("/host/skills")
    const messages = await agent.getMessages()
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ])
    expect(
      events.some(
        (event) =>
          (event.type === "message_start" || event.type === "message_end") &&
          event.message.role === "system",
      ),
    ).toBe(false)
    expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1)
    expect(events.at(-1)?.type).toBe("agent_end")
    expect(agent.state.isStreaming).toBe(false)
  })

  it("delivers queued next-turn input with the next prompt", async () => {
    const root = await tempRoot("next-turn")
    const { faux, models, model: fauxModel } = fauxSetup()
    const agent = await TestAgent.open({
      session: { path: join(root, "session.jsonl"), id: "next-turn-run", cwd: root },
      models,
      model: fauxModel,
      compaction: false,
    })
    const seen: string[] = []
    faux.setResponses([
      (context) => {
        const last = context.messages.at(-1)
        if (last?.role === "user") {
          seen.push(
            typeof last.content === "string"
              ? last.content
              : last.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          )
        }
        return fauxAssistantMessage("ok")
      },
    ])

    await agent.queueUserMessage("human hint")
    expect(agent.hasQueuedMessages()).toBe(true)
    await agent.prompt("continue")

    expect(seen).toEqual(["human hint\n\ncontinue"])
    expect(agent.hasQueuedMessages()).toBe(false)
    await expect(agent.steer("late")).rejects.toThrow("Cannot steer while idle")
  })

  it("persists the session at the configured path with the run id", async () => {
    const root = await tempRoot("persist")
    const { faux, models, model: fauxModel } = fauxSetup()
    const path = join(root, "nested", "session.jsonl")
    const agent = await TestAgent.open({
      session: { path, id: "persist-run", cwd: root, metadata: { agentType: "test" } },
      models,
      model: fauxModel,
      compaction: false,
    })
    faux.setResponses([fauxAssistantMessage("persisted")])
    await agent.prompt("hello")

    const reopened = await TestAgent.open({
      session: { path, id: "persist-run", cwd: root },
      models,
      model: fauxModel,
      compaction: false,
    })
    expect(reopened.restored).toBe(true)
    expect(reopened.sessionManager.getHeader()).toMatchObject({ id: "persist-run" })
    expect((await reopened.getMessages()).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ])
  })
})
