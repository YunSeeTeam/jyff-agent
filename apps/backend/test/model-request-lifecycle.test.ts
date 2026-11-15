import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BaseAgent,
  type BaseAgentOptions,
  CtfSubagent,
  CtfTldrAgent,
  withModelRequestScope,
  currentModelRequestScope,
  modelsFromAgentOptions,
  prepareBaseAgent,
  type ModelRequestEvent,
} from "@ctf-agent/agents"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { gateProviderStream, ProviderRequestGate } from "../src/domain/provider-request-gate.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const model: Model<"openai-completions"> = {
  id: "offline",
  name: "Offline",
  api: "openai-completions",
  provider: "offline",
  baseUrl: "https://invalid.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 22_000,
  maxTokens: 4096,
}
class TestAgent extends BaseAgent {
  static async open(options: BaseAgentOptions) {
    return new TestAgent(await prepareBaseAgent(options), { compaction: false })
  }
}

describe("T27 actual Pi request entry points", () => {
  it("a standalone TLDR auxiliary call has Project/Challenge identity and no invented Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "tldr-lifecycle-"))
    roots.push(root)
    const pending = createAssistantMessageEventStream()
    const events: ModelRequestEvent[] = []
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 0, requestTimeoutMs: 100, idleTimeoutMs: 30 }),
      () => pending,
    )
    const agent = await CtfTldrAgent.create({
      projectId: "p",
      challenge: {
        id: "c",
        title: "Offline",
        category: "misc",
        score: 1,
        description: "test",
        attachments: [],
      },
      sessionPath: join(root, "tldr.jsonl"),
      tools: [],
      agent: {
        streamFn: stream as AgentOptions["streamFn"],
        initialState: { model, thinkingLevel: "off" },
      },
    })
    try {
      await withModelRequestScope({ onEvent: (event) => events.push(event) }, () =>
        agent.prompt("summarize local evidence"),
      )
      expect(events.at(-1)).toMatchObject({
        projectId: "p",
        challengeId: "c",
        agentId: "tldr",
        purpose: "tldr",
        executionId: expect.any(String),
        state: "failed",
        usageKnown: false,
      })
      expect(events.at(-1)?.runId).toBeUndefined()
    } finally {
      pending.end(fauxAssistantMessage("late"))
      await agent.close()
    }
  })

  it.each(["prompt", "compaction", "branch_summary"] as const)(
    "%s propagates identity, times out, and can retry without losing the session",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), "model-lifecycle-"))
      roots.push(root)
      const events: ModelRequestEvent[] = []
      let hang = true
      const pending = createAssistantMessageEventStream()
      let requests = 0
      const stream = gateProviderStream(
        new ProviderRequestGate({ minimumIntervalMs: 0, requestTimeoutMs: 100, idleTimeoutMs: 30 }),
        () => {
          requests++
          expect(currentModelRequestScope()).toMatchObject({
            projectId: "p",
            challengeId: "c",
            runId: "r",
          })
          if (hang) return pending
          const result = createAssistantMessageEventStream()
          const reply = {
            ...fauxAssistantMessage("Recovered summary and evidence"),
            provider: model.provider,
            api: model.api,
            model: model.id,
          }
          result.push({ type: "done", reason: "stop", message: reply })
          result.end(reply)
          return result
        },
      )
      const legacy: AgentOptions = { streamFn: stream as AgentOptions["streamFn"] }
      const agent = await TestAgent.open({
        session: { path: join(root, "session.jsonl"), id: "r", cwd: root },
        models: modelsFromAgentOptions(legacy, model),
        model,
        thinkingLevel: "off",
        requestScope: () => ({
          projectId: "p",
          challengeId: "c",
          runId: "r",
          agentId: "solver",
          purpose: "solver",
          onEvent: (event) => events.push(event),
        }),
        initialMessages: [
          { role: "user", content: "prior evidence " + "x".repeat(12_000), timestamp: 1 },
          fauxAssistantMessage("prior analysis"),
          { role: "user", content: "next path " + "y".repeat(12_000), timestamp: 2 },
          fauxAssistantMessage("recent analysis"),
        ],
      })
      const target = agent.sessionManager
        .getEntries()
        .find((entry) => entry.type === "message" && entry.message.role === "user")!.id
      const run = () =>
        operation === "prompt"
          ? agent.prompt("continue")
          : operation === "compaction"
            ? agent.compact()
            : agent.navigateTree(target, { summarize: true })
      try {
        await run().catch(() => undefined)
        expect(requests).toBe(1) // Pi/SDK must not silently multiply retries.
        expect(events.at(-1)).toMatchObject({
          runId: "r",
          executionId: expect.any(String),
          purpose: operation === "prompt" ? "solver" : operation,
          sent: true,
          usageKnown: false,
          state: "failed",
        })
        hang = false
        await run()
        expect(events.at(-1)).toMatchObject({ state: "completed", usageKnown: true })
        expect(agent.sessionManager.buildSessionContext().messages.length).toBeGreaterThan(0)
      } finally {
        pending.end(fauxAssistantMessage("late"))
        await agent.abort()
      }
    },
  )

  it("a real SubAgent prompt keeps its own execution identity and rejects sends after cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-lifecycle-"))
    roots.push(root)
    const events: ModelRequestEvent[] = []
    let cancelled = false
    let calls = 0
    const stream = gateProviderStream(new ProviderRequestGate({ minimumIntervalMs: 0 }), () => {
      calls++
      const result = createAssistantMessageEventStream()
      const reply = fauxAssistantMessage("local evidence")
      result.push({ type: "done", reason: "stop", message: reply })
      result.end(reply)
      return result
    })
    const agent = await CtfSubagent.create({
      projectId: "p",
      runId: "r",
      runDirectory: root,
      subagentId: "worker",
      containerCwd: "/workspace/subagents/worker",
      challenge: {
        id: "c",
        title: "Offline",
        category: "misc",
        score: 1,
        description: "test",
        attachments: [],
      },
      sandbox: {
        id: "offline",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        close: async () => {},
      },
      agent: {
        streamFn: stream as AgentOptions["streamFn"],
        initialState: { model, thinkingLevel: "off" },
      },
      role: {
        name: "worker",
        displayName: "Worker",
        description: "test",
        systemPrompt: "test",
        thinkingLevel: "off",
        enabled: true,
        source: "builtin",
      },
      requestScope: () => ({
        executionId: "worker-exec",
        canSend: () => !cancelled,
        onEvent: (event) => events.push(event),
      }),
    })
    try {
      await agent.prompt("analyze local evidence")
      expect(events.at(-1)).toMatchObject({
        projectId: "p",
        challengeId: "c",
        runId: "r",
        agentId: "worker",
        executionId: "worker-exec",
        purpose: "subagent",
        state: "completed",
      })
      cancelled = true
      await agent.prompt("must not send")
      expect(calls).toBe(1)
      expect(events.at(-1)).toMatchObject({ state: "failed", sent: false })
    } finally {
      await agent.close()
    }
  })
})
