import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentMessage,
  JsonlSessionStorage,
  Session,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it } from "vite-plus/test"

// Stage 0 contract probe for the locked Pi session format. Execution-scoped
// subagent reports (design doc 7.3) rely on these behaviours; re-run this file
// before changing the Pi version.

const MARKER = "ctf_subagent_execution"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function createSession() {
  const root = await mkdtemp(join(tmpdir(), "pi-session-contract-"))
  roots.push(root)
  const path = join(root, "session.jsonl")
  const env = new NodeExecutionEnv({ cwd: root })
  const storage = await JsonlSessionStorage.create(env, path, { cwd: root, sessionId: "contract" })
  return { path, env, session: new Session(storage) }
}

async function reopen(env: NodeExecutionEnv, path: string) {
  return new Session(await JsonlSessionStorage.open(env, path))
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() }
}

/** Walk raw parentId links from the leaf back to the marker of one execution. */
async function entriesSinceMarker(session: Session, executionId: string) {
  const collected: SessionTreeEntry[] = []
  let id = await session.getLeafId()
  while (id) {
    const entry = await session.getEntry(id)
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

function messageTexts(entries: readonly SessionTreeEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return []
    const { message } = entry
    if (message.role !== "user" && message.role !== "assistant") return []
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    return [`${message.role}:${text}`]
  })
}

describe("locked Pi session contract for execution-scoped reports", () => {
  it("persists a custom entry appended before any message", async () => {
    const { env, path, session } = await createSession()
    const markerId = await session.appendCustomEntry(MARKER, { executionId: "exec-1" })

    const reopened = await reopen(env, path)
    expect(await reopened.getEntry(markerId)).toMatchObject({
      type: "custom",
      customType: MARKER,
      data: { executionId: "exec-1" },
    })
    expect(await reopened.getLeafId()).toBe(markerId)
  })

  it("keeps custom entries out of the model context", async () => {
    const { session } = await createSession()
    await session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    await session.appendMessage(user("task"))
    await session.appendMessage(fauxAssistantMessage("report"))

    const context = await session.buildContext()
    expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  })

  it("reaches the marker across a retainedTail compaction that getBranch stops at", async () => {
    const { env, path, session } = await createSession()
    await session.appendMessage(user("previous execution"))
    await session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    await session.appendMessage(user("current task"))
    const beforeCompaction = fauxAssistantMessage("partial before compaction")
    await session.appendMessage(beforeCompaction)
    await session.appendCompaction("summary", undefined, 1_000, undefined, false, undefined, [
      beforeCompaction,
    ])
    await session.appendMessage(fauxAssistantMessage("final after compaction"))

    const branch = await session.getBranch()
    expect(branch.some((entry) => entry.type === "custom")).toBe(false)

    for (const target of [session, await reopen(env, path)]) {
      const walk = await entriesSinceMarker(target, "exec-1")
      expect(walk.boundary).toBe("marker")
      expect(messageTexts(walk.entries)).toEqual([
        "user:current task",
        "assistant:partial before compaction",
        "assistant:final after compaction",
      ])
      expect(walk.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1)
    }
  })

  it("reaches the marker across a firstKeptEntryId compaction", async () => {
    const { session } = await createSession()
    await session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    const keptId = await session.appendMessage(user("current task"))
    await session.appendMessage(fauxAssistantMessage("analysis"))
    await session.appendCompaction("summary", keptId, 1_000)
    await session.appendMessage(fauxAssistantMessage("final"))

    const branch = await session.getBranch()
    expect(branch[0]?.id).toBe(keptId)

    const walk = await entriesSinceMarker(session, "exec-1")
    expect(walk.boundary).toBe("marker")
    expect(messageTexts(walk.entries)).toEqual([
      "user:current task",
      "assistant:analysis",
      "assistant:final",
    ])
  })

  it("separates two executions of the same session by their markers", async () => {
    const { session } = await createSession()
    await session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    await session.appendMessage(user("first task"))
    await session.appendMessage(fauxAssistantMessage("same report"))
    await session.appendCustomEntry(MARKER, { executionId: "exec-2" })
    await session.appendMessage(user("resume"))
    await session.appendMessage(fauxAssistantMessage("same report"))

    const second = await entriesSinceMarker(session, "exec-2")
    expect(second.boundary).toBe("marker")
    expect(messageTexts(second.entries)).toEqual(["user:resume", "assistant:same report"])
    expect((await entriesSinceMarker(session, "exec-unknown")).boundary).toBe("root")
  })

  it("drops abandoned branch entries from the raw chain after moveTo", async () => {
    const { session } = await createSession()
    await session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    await session.appendMessage(user("task"))
    const firstAttempt = await session.appendMessage(fauxAssistantMessage("first attempt"))
    await session.appendMessage(fauxAssistantMessage("abandoned"))
    await session.moveTo(firstAttempt)
    await session.appendMessage(fauxAssistantMessage("retry"))

    const walk = await entriesSinceMarker(session, "exec-1")
    expect(walk.boundary).toBe("marker")
    expect(messageTexts(walk.entries)).toEqual([
      "user:task",
      "assistant:first attempt",
      "assistant:retry",
    ])
  })

  it("opens a file with a missing parent, leaving broken-chain detection to the caller", async () => {
    const { env, path, session } = await createSession()
    await session.appendCustomEntry(MARKER, { executionId: "exec-1" })
    const removedId = await session.appendMessage(user("task"))
    await session.appendMessage(fauxAssistantMessage("report"))

    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim())
    await writeFile(
      path,
      `${lines.filter((line) => (JSON.parse(line) as { id?: string }).id !== removedId).join("\n")}\n`,
    )

    const reopened = await reopen(env, path)
    expect(await reopened.getEntry(removedId)).toBeUndefined()
    expect((await entriesSinceMarker(reopened, "exec-1")).boundary).toBe("missing_parent")
    await expect(reopened.getBranch()).rejects.toThrow(/not found/)
  })
})
