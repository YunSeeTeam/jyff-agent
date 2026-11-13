import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { collectSubagentReport, markSubagentExecution } from "../../src/subagent/session-report.ts"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "subagent-report-"))
  roots.push(root)
  const path = join(root, "session.jsonl")
  await writeFile(
    path,
    JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "report",
      timestamp: new Date().toISOString(),
      cwd: root,
    }) + "\n",
  )
  return { path, session: SessionManager.open(path) }
}

describe("execution-scoped original report (T11/T12)", () => {
  it("retains a long text-only final across compactions, branching and reopening", async () => {
    const { session, path } = await fixture()
    session.appendMessage(fauxAssistantMessage("previous execution"))
    markSubagentExecution(session, "one")
    const first = session.appendMessage(fauxAssistantMessage("initial"))
    session.appendCompaction("summary must not become report", first, 1000)
    const branch = session.appendMessage(fauxAssistantMessage("retained original"))
    session.appendMessage(fauxAssistantMessage("abandoned"))
    session.branch(branch)
    session.appendCompaction("second summary", branch, 2000)
    const text = "界😀".repeat(5000) + "tail-sentinel"
    session.appendMessage(
      fauxAssistantMessage([
        { type: "thinking", thinking: "private", thinkingSignature: "sig" },
        { type: "text", text },
      ]),
    )
    for (const target of [session, SessionManager.open(path)]) {
      expect(collectSubagentReport(target, "one", "completed")).toEqual({
        available: true,
        kind: "assistant_final",
        text,
      })
    }
  })

  it("never fills an empty resumed execution with an earlier report", async () => {
    const { session } = await fixture()
    markSubagentExecution(session, "old")
    session.appendMessage(fauxAssistantMessage("old report"))
    markSubagentExecution(session, "new")
    expect(collectSubagentReport(session, "new", "failed")).toEqual({
      available: false,
      reason: "no_report",
    })
    expect(collectSubagentReport(session, "old", "completed")).toMatchObject({
      available: false,
      reason: "boundary_unavailable",
    })
  })

  it("selects the latest original tool text for partial outcomes only", async () => {
    const { session } = await fixture()
    markSubagentExecution(session, "one")
    session.appendMessage(fauxAssistantMessage("assistant observation"))
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "bash",
      content: [{ type: "text", text: "raw evidence" }],
      isError: false,
      timestamp: Date.now(),
    })
    expect(collectSubagentReport(session, "one", "cancelled")).toEqual({
      available: true,
      kind: "tool_partial",
      text: "raw evidence",
    })
    expect(collectSubagentReport(session, "one", "completed")).toMatchObject({
      kind: "assistant_final",
      text: "assistant observation",
    })
  })

  it("refuses missing markers, parents and cycles even after finding text", async () => {
    const { session } = await fixture()
    const leaf = session.appendMessage(fauxAssistantMessage("untrusted without boundary"))
    expect(collectSubagentReport(session, "missing", "failed")).toMatchObject({
      reason: "boundary_unavailable",
    })
    const entry = session.getEntry(leaf)!
    expect(
      collectSubagentReport(
        { getLeafId: () => leaf, getEntry: () => ({ ...entry, parentId: leaf }) },
        "one",
        "completed",
      ),
    ).toMatchObject({ reason: "boundary_unavailable", detail: expect.stringContaining("cycle") })
    expect(
      collectSubagentReport(
        { getLeafId: () => leaf, getEntry: () => undefined },
        "one",
        "completed",
      ),
    ).toMatchObject({ reason: "boundary_unavailable", detail: expect.stringContaining("missing") })
  })
})
