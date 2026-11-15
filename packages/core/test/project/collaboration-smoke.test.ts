import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, posix } from "node:path"
import type { CommandResult, Sandbox, SandboxExecOptions } from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { TranscriptContext } from "@earendil-works/pi-ai"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { defaultRunSettings, mergeRunSettings } from "../../src/contracts/index.ts"
import { Project } from "../../src/project/project.ts"
import { TestPlatformPlugin } from "../fake-platform.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Only the file operations used here, backed by the actual materialized workspace. */
class WorkspaceSandbox implements Sandbox {
  readonly id = "local-collaboration-smoke"
  readonly reads: string[] = []
  closed = false
  constructor(private readonly workspace: string) {}

  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    if (args[0] !== "python3") throw new Error("This smoke permits file operations only")
    const input = JSON.parse(options?.input ?? "{}") as { op: string; path: string }
    const path = posix.normalize(input.path)
    if (path !== "/workspace" && !path.startsWith("/workspace/"))
      throw new Error("Smoke file operation escaped its workspace")
    const hostPath = join(this.workspace, path.slice("/workspace".length))
    let value: unknown
    switch (input.op) {
      case "canonical":
        value = path
        break
      case "mkdir":
        await mkdir(hostPath, { recursive: true })
        value = null
        break
      case "exists":
        value = await access(hostPath).then(
          () => true,
          () => false,
        )
        break
      case "info": {
        const info = await stat(hostPath)
        value = {
          name: basename(path),
          path,
          kind: info.isDirectory() ? "directory" : "file",
          size: info.size,
          mtimeMs: info.mtimeMs,
        }
        break
      }
      case "read_binary":
        this.reads.push(path)
        value = (await readFile(hostPath)).toString("base64")
        break
      default:
        throw new Error(`Unexpected smoke file operation: ${input.op}`)
    }
    return { code: 0, stdout: JSON.stringify({ ok: true, value }), stderr: "" }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function toolText(context: TranscriptContext, id: string): string {
  const result = context.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === id,
  )
  if (result?.role !== "toolResult" || result.isError)
    throw new Error(`Missing successful tool result: ${id}`)
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
}

describe("local three-way collaboration smoke", () => {
  it("executes Agent, child reader/full and frozen skill reads, then reads the complete versioned report through Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctf-collaboration-smoke-"))
    roots.push(root)
    const source = join(root, ".pi", "skills", "receipt-audit")
    await mkdir(join(source, "references"), { recursive: true })
    const nonce = randomUUID(),
      rule = randomUUID()
    const skill =
      "---\nname: receipt-audit\ndescription: Audit a synthetic receipt\n---\nRead references/rules.json and the complete evidence before writing the receipt."
    await writeFile(join(source, "SKILL.md"), skill)
    await writeFile(join(source, "references", "rules.json"), JSON.stringify({ rule }))
    const platform = new TestPlatformPlugin()
    let sandbox!: WorkspaceSandbox
    const project = await Project.open({
      root,
      config: {
        version: 1,
        project: { id: "collaboration-smoke", name: "Synthetic collaboration" },
        platform: {
          plugin: "test",
          config: {
            challenges: [
              {
                id: "receipt",
                title: "Synthetic receipt",
                category: "misc",
                score: 0,
                description: "Audit local synthetic records; do not submit anything.",
                attachments: [],
                flag: "",
              },
            ],
          },
        },
        sandbox: { image: "unused", privileged: false, networkMode: "none" },
      },
      platforms: [platform],
      sandboxFactory: async (options) => (sandbox = new WorkspaceSandbox(options.workspace)),
      runSettings: () =>
        mergeRunSettings(defaultRunSettings(), {
          optimization: {
            blackboardReaderV2: true,
            fullSubagentReports: true,
            skillSnapshots: true,
          },
          skills: { solver: [], subagents: { default: ["receipt-audit"], roles: {} } },
        }),
    })
    const faux = createFauxCore({ provider: "local-three-way-smoke" })
    let evidenceId = 0,
      parentTurns = 0,
      childTurns = 0
    let frozenPath = "",
      producedReport = "",
      reconstructedReport = "",
      finalReceipt = ""
    const pages: Array<{
      offset: number
      resultVersion: string
      result: string
      nextOffset?: number
    }> = []
    const respond: FauxResponseFactory = (context) => {
      const system = JSON.stringify(context.messages.filter((message) => message.role === "system"))
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
        fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" })
      if (system.includes("<subagent_context>")) {
        childTurns++
        if (childTurns === 1) {
          frozenPath = system.match(/\/workspace\/\.skills\/[^"<>\s]+\/SKILL\.md/)?.[0] ?? ""
          if (!frozenPath) throw new Error("Child did not receive a frozen skill location")
          return fauxAssistantMessage(
            [
              fauxToolCall(
                "blackboard_read",
                { view: "full", ids: [evidenceId] },
                { id: "child-evidence" },
              ),
              fauxToolCall("read", { path: frozenPath }, { id: "child-skill" }),
            ],
            { stopReason: "toolUse" },
          )
        }
        if (childTurns === 2) {
          if (!toolText(context, "child-skill").includes("references/rules.json"))
            throw new Error("Skill read did not return the actual package instructions")
          return call(
            "read",
            { path: posix.join(posix.dirname(frozenPath), "references/rules.json") },
            "child-rule",
          )
        }
        if (childTurns !== 3) throw new Error("Unexpected extra child model request")
        const evidence = JSON.parse(toolText(context, "child-evidence")).entries[0]
        const observedNonce = evidence.description.match(/nonce=([^\s]+)/)?.[1]
        const observedRule = JSON.parse(toolText(context, "child-rule")).rule
        const receipt = {
          nonce: observedNonce,
          rule: observedRule,
          evidenceId: evidence.id,
          contentHash: evidence.contentHash,
        }
        producedReport =
          "Synthetic audit observation.\n".repeat(310) + "RECEIPT:" + JSON.stringify(receipt)
        return fauxAssistantMessage(producedReport)
      }
      parentTurns++
      if (parentTurns === 1) {
        expect(system).not.toContain("<name>receipt-audit</name>")
        return call(
          "Agent",
          {
            subagent_type: "general-purpose",
            prompt: `Audit synthetic evidence ${evidenceId} using your assigned skill. Return a report with a receipt; do not submit anything.`,
            description: "synthetic audit",
            run_in_background: false,
          },
          "parent-launch",
        )
      }
      const launch = JSON.parse(toolText(context, "parent-launch"))
      if (parentTurns === 2) {
        expect(launch.result).not.toContain("RECEIPT:")
        expect(launch.hasMore).toBe(true)
        return call(
          "get_subagent_result",
          { agent_id: launch.agentId, limit: 8000 },
          "parent-page-0",
        )
      }
      if (parentTurns === 3) {
        const page = JSON.parse(toolText(context, "parent-page-0"))
        pages.push(page)
        return call(
          "get_subagent_result",
          {
            agent_id: launch.agentId,
            limit: 8000,
            offset: page.nextOffset,
            expected_result_version: page.resultVersion,
          },
          "parent-page-1",
        )
      }
      if (parentTurns !== 4) throw new Error("Unexpected extra parent model request")
      pages.push(JSON.parse(toolText(context, "parent-page-1")))
      reconstructedReport = pages.map((page) => page.result).join("")
      finalReceipt = reconstructedReport.split("RECEIPT:")[1] ?? ""
      return fauxAssistantMessage(finalReceipt)
    }
    faux.setResponses(Array.from({ length: 7 }, () => respond))
    try {
      const solver = await project.createSolver("receipt", {
        agent: {
          streamFn: faux.streamSimple as AgentOptions["streamFn"],
          initialState: { model: faux.getModel(), thinkingLevel: "off" },
        },
      })
      const seeded = await solver.tools
        .find((tool) => tool.name === "blackboard_record")!
        .execute("seed", {
          evidence: { description: "Synthetic context. ".repeat(35) + `nonce=${nonce}` },
        })
      evidenceId = (seeded.details as { evidence: { id: number } }).evidence.id
      const index = project.blackboardPage("receipt")
      expect(JSON.stringify(index)).not.toContain(nonce)
      // The child must read the already-frozen package, not these changed source bytes.
      await writeFile(
        join(source, "references", "rules.json"),
        JSON.stringify({ rule: "changed-after-freeze" }),
      )
      await solver.prompt(
        "Delegate the synthetic audit and read its complete report. Do not submit anything.",
      )
      await solver.waitForIdle()

      expect(parentTurns).toBe(4)
      expect(childTurns).toBe(3)
      expect(faux.state.callCount).toBe(7)
      expect(reconstructedReport).toBe(producedReport)
      expect(pages.map((page) => page.offset)).toEqual([0, 8000])
      expect(new Set(pages.map((page) => page.resultVersion)).size).toBe(1)
      expect(JSON.parse(finalReceipt)).toMatchObject({
        nonce,
        rule,
        evidenceId,
        contentHash: expect.stringMatching(/^v1:/),
      })
      expect(sandbox.reads).toEqual([
        frozenPath,
        posix.join(posix.dirname(frozenPath), "references/rules.json"),
      ])
      expect(frozenPath).toContain(`/workspace/.skills/${solver.runId}/`)
      expect(project.subagents(solver.runId)).toEqual([
        expect.objectContaining({
          status: "completed",
          resultKind: "assistant_final",
          result: producedReport,
          executionId: expect.any(String),
        }),
      ])
      expect(platform.diagnostics().submissions).toEqual({})
      await solver.close("manual")
      expect(sandbox.closed).toBe(true)
    } finally {
      await project.close()
    }
  })
})
