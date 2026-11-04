import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CTF_COMPACTION_PROMPT, SUBAGENT_COMPACTION_PROMPT } from "@ctf-agent/prompts"
import type { CommandResult, Sandbox } from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { CtfSubagent } from "../../src/subagent/subagent-agent.ts"
import type { SubagentRole } from "../../src/subagent/registry.ts"

const model: Model<"openai-completions"> = {
  id: "worker-model",
  name: "Worker model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://invalid.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const agent = {
  streamFn: (() => {
    throw new Error("this test does not call the model")
  }) as AgentOptions["streamFn"],
  initialState: { model },
} satisfies AgentOptions

const role: SubagentRole = {
  name: "worker",
  displayName: "Worker",
  description: "Test worker",
  systemPrompt: "You are a test worker.",
  thinkingLevel: "off",
  enabled: true,
  source: "builtin",
}

class IdleSandbox implements Sandbox {
  readonly id = "sandbox"
  async exec(): Promise<CommandResult> {
    return { code: 0, stdout: "", stderr: "" }
  }
  async close(): Promise<void> {}
}

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createSubagent(): Promise<CtfSubagent> {
  const runDirectory = await mkdtemp(join(tmpdir(), "subagent-agent-"))
  roots.push(runDirectory)
  return CtfSubagent.create({
    projectId: "project",
    runId: "run",
    runDirectory,
    subagentId: "worker-1",
    containerCwd: "/workspace/subagents/worker-1",
    challenge: {
      id: "challenge",
      title: "Challenge",
      category: "misc",
      score: 100,
      description: "test",
      attachments: [],
    },
    sandbox: new IdleSandbox(),
    agent,
    role,
  })
}

describe("CtfSubagent compaction (T06)", () => {
  it("compacts with the SubAgent prompt instead of the Solver prompt", async () => {
    const compact = vi.spyOn(AgentSession.prototype, "compact").mockResolvedValue({
      summary: "worker summary",
      firstKeptEntryId: "entry",
      tokensBefore: 1_024,
    })
    const subagent = await createSubagent()

    await expect(subagent.compact()).resolves.toMatchObject({ summary: "worker summary" })
    expect(compact).toHaveBeenCalledExactlyOnceWith(SUBAGENT_COMPACTION_PROMPT)
    await subagent.close()
  })

  it("does not promise the snapshots only the Solver gets back after compaction", () => {
    // The Solver's prompt relies on the control plane re-injecting these sections.
    expect(CTF_COMPACTION_PROMPT).toContain("<challenge_blackboard>")
    expect(SUBAGENT_COMPACTION_PROMPT).not.toContain("<challenge_blackboard>")
    expect(SUBAGENT_COMPACTION_PROMPT).not.toContain("<active_subagents>")
    expect(SUBAGENT_COMPACTION_PROMPT).toContain("Nothing is re-injected after compaction.")
    expect(SUBAGENT_COMPACTION_PROMPT).toContain("Preserve the delegated task")
  })

  it("works in its own container directory", async () => {
    const subagent = await createSubagent()
    expect(subagent.systemPrompt).toContain("/workspace/subagents/worker-1")
    await subagent.close()
  })
})
