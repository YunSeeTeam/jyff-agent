import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { getCurrentTools, type UserMessage } from "@earendil-works/pi-ai"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import {
  CURRENT_SESSION_VERSION,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vite-plus/test"

// Contract probe for the locked Pi session format (pi-coding-agent SessionManager).
// BaseAgent's session restore and execution-scoped subagent reports (design doc
// 7.3) rely on these behaviours; re-run this file before changing the Pi version.

const MARKER = "ctf_subagent_execution"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function sessionPath(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-contract-"))
  roots.push(root)
  return { root, path: join(root, "session.jsonl") }
}

/** BaseAgent writes the header itself so the session keeps the run id and path. */
async function createSession() {
  const { root, path } = await sessionPath()
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "contract",
    timestamp: new Date().toISOString(),
    cwd: root,
  }
  await writeFile(path, `${JSON.stringify(header)}\n`)
  return { path, session: SessionManager.open(path) }
}

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() }
}

/** Walk raw parentId links from the leaf back to the marker of one execution. */
function entriesSinceMarker(session: SessionManager, executionId: string) {
  const collected: SessionEntry[] = []
  let id = session.getLeafId()
  while (id) {
    const entry = session.getEntry(id)
    if (!entry) return { boundary: "missing_parent" as const, entries: collected.reverse() }
    if (
      entry.type === "custom" &&
      entry.customType === MARKER &&
      (entry.data as { executionId?: string } | undefined)?.executionId === executionId
    ) {
      return { boundary: "marker" as const, entries: collected.reverse() }
    }
    collected.push(entry)
    id = entry.parentId
  }
  return { boundary: "root" as const, entries: collected.reverse() }
}

function messageTexts(entries: readonly SessionEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return []
    const message = entry.message as AgentMessage
    if (message.role !== "user" && message.role !== "assistant") return []
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    return [`${message.role}:${text}`]
  })
}

describe("locked Pi session contract", () => {
  it("keeps a pre-written header and appends every entry immediately", async () => {
    const { path, session } = await createSession()
    expect(session.getSessionId()).toBe("contract")
    const markerId = session.appendCustomEntry(MARKER, { executionId: "exec-1" })

    const reopened = SessionManager.open(path)
    expect(reopened.getSessionId()).toBe("contract")
    expect(reopened.getEntry(markerId)).toMatchObject({
      type: "custom",
      customType: MARKER,
      data: { executionId: "exec-1" },
    })
    expect(reopened.getLeafId()).toBe(markerId)
  })

  it("keeps custom entries out of the model context", async () => {
    const { session } = await createSession()
    session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    session.appendMessage(user("task"))
    session.appendMessage(fauxAssistantMessage("report"))

    const context = session.buildSessionContext()
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  it("replays persisted system messages into the declared tool set", async () => {
    const { path, session } = await createSession()
    const tool = { name: "read", description: "Read files", parameters: { type: "object" } }
    session.appendMessage({ role: "system", content: "prompt", toolsAdded: [tool], timestamp: 1 })
    session.appendMessage({
      role: "system",
      content: "",
      toolsRemoved: [{ name: "read" }],
      timestamp: 2,
    })

    const systemMessages = SessionManager.open(path)
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
      )
    expect(systemMessages).toHaveLength(2)
    expect(getCurrentTools(systemMessages)).toEqual([])
  })

  it("reaches the marker across a firstKeptEntryId compaction", async () => {
    const { path, session } = await createSession()
    session.appendMessage(user("previous execution"))
    session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    const keptId = session.appendMessage(user("current task"))
    session.appendMessage(fauxAssistantMessage("analysis"))
    session.appendCompaction("summary", keptId, 1_000)
    session.appendMessage(fauxAssistantMessage("final"))

    expect(session.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "compactionSummary",
      "user",
      "assistant",
      "assistant",
    ])
    for (const target of [session, SessionManager.open(path)]) {
      const walk = entriesSinceMarker(target, "exec-1")
      expect(walk.boundary).toBe("marker")
      expect(messageTexts(walk.entries)).toEqual([
        "user:current task",
        "assistant:analysis",
        "assistant:final",
      ])
      expect(walk.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1)
    }
  })

  it("separates two executions of the same session by their markers", async () => {
    const { session } = await createSession()
    session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    session.appendMessage(user("first task"))
    session.appendMessage(fauxAssistantMessage("same report"))
    session.appendCustomEntry(MARKER, { executionId: "exec-2" })
    session.appendMessage(user("resume"))
    session.appendMessage(fauxAssistantMessage("same report"))

    const second = entriesSinceMarker(session, "exec-2")
    expect(second.boundary).toBe("marker")
    expect(messageTexts(second.entries)).toEqual(["user:resume", "assistant:same report"])
    expect(entriesSinceMarker(session, "exec-unknown").boundary).toBe("root")
  })

  it("drops abandoned branch entries from the raw chain after branching", async () => {
    const { session } = await createSession()
    session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    session.appendMessage(user("task"))
    const firstAttempt = session.appendMessage(fauxAssistantMessage("first attempt"))
    session.appendMessage(fauxAssistantMessage("abandoned"))
    session.branch(firstAttempt)
    session.appendMessage(fauxAssistantMessage("retry"))

    const walk = entriesSinceMarker(session, "exec-1")
    expect(walk.boundary).toBe("marker")
    expect(messageTexts(walk.entries)).toEqual([
      "user:task",
      "assistant:first attempt",
      "assistant:retry",
    ])
  })

  it("opens a file with a missing parent, leaving broken-chain detection to the caller", async () => {
    const { path, session } = await createSession()
    session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    const removedId = session.appendMessage(user("task"))
    session.appendMessage(fauxAssistantMessage("report"))

    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim())
    await writeFile(
      path,
      `${lines.filter((line) => (JSON.parse(line) as { id?: string }).id !== removedId).join("\n")}\n`,
    )

    const reopened = SessionManager.open(path)
    expect(reopened.getEntry(removedId)).toBeUndefined()
    expect(entriesSinceMarker(reopened, "exec-1").boundary).toBe("missing_parent")
    expect(messageTexts(reopened.getBranch())).toEqual(["assistant:report"])
  })

  it("reads a Pi 0.82 session file, ignoring entry types it no longer writes", async () => {
    const { root, path } = await sessionPath()
    const lines = [
      {
        type: "session",
        version: 3,
        id: "legacy-run",
        timestamp: "2026-11-03T04:27:22.981Z",
        cwd: root,
        metadata: { agentType: "ctf-solver" },
      },
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-11-03T04:27:22.983Z",
        message: user("challenge context"),
      },
      {
        type: "model_change",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-11-03T04:27:22.986Z",
        provider: "custom-deepseek-flash",
        modelId: "deepseek-flash",
      },
      {
        type: "thinking_level_change",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-11-03T04:27:22.988Z",
        thinkingLevel: "medium",
      },
      {
        type: "active_tools_change",
        id: "a4",
        parentId: "a3",
        timestamp: "2026-11-03T04:27:22.990Z",
        activeToolNames: ["bash", "read"],
      },
      {
        type: "message",
        id: "a5",
        parentId: "a4",
        timestamp: "2026-11-03T04:27:30.000Z",
        // Pi 1.x also derives the restored model from the latest response.
        message: {
          ...fauxAssistantMessage("analysis"),
          provider: "custom-deepseek-flash",
          model: "deepseek-flash",
        },
      },
    ]
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)

    const legacy = SessionManager.open(path)
    expect(legacy.getSessionId()).toBe("legacy-run")
    expect(legacy.getBranch().map((entry) => entry.id)).toEqual(["a1", "a2", "a3", "a4", "a5"])
    const context = legacy.buildSessionContext()
    expect(context.model).toEqual({ provider: "custom-deepseek-flash", modelId: "deepseek-flash" })
    expect(context.thinkingLevel).toBe("medium")
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  })
})
