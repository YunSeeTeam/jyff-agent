import { createHash } from "node:crypto"
import { DockerSandbox, FixedAttachmentReader, type matchFixedAttachment } from "@ctf-agent/sandbox"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import type {
  FixedAttachmentReadStore,
  FixedReadReceipt,
} from "../persistence/fixed-attachment-reads.ts"

const actions = ["open", "list", "status", "first", "second", "finish"] as const
type Action = (typeof actions)[number]
const missing = () => new Error("Fixed attachment session not found in this scope")

function describeOutput(data: Buffer, window: 1 | 2) {
  const split = window === 1 ? 12294 : 12295
  const stream = (bytes: Buffer) => ({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })
  return { window, stdout: stream(data.subarray(0, split)), stderr: stream(data.subarray(split)) }
}

/** One immutable attachment for one Run. Identity comes from the Project and SubAgent manager. */
export class FixedAttachmentReads {
  private readonly readers = new Map<string, FixedAttachmentReader>()
  private pending: Promise<void> = Promise.resolve()
  private closing = false

  constructor(
    private readonly runId: string,
    private readonly store: FixedAttachmentReadStore,
    private readonly sandbox: DockerSandbox,
    private readonly attachment: NonNullable<ReturnType<typeof matchFixedAttachment>>,
  ) {}

  tool(actor: string): AgentTool {
    return {
      name: "fixed_attachment_read",
      label: "Read fixed attachment",
      description:
        "Read two predefined byte windows from this Run's pinned offline archive. Open returns your sessionId. Use first then second and finish. A repeated window returns its saved checksums. List shows up to 32 recent sessions available to you.",
      parameters: Type.Object(
        {
          action: Type.Union(actions.map((action) => Type.Literal(action))),
          sessionId: Type.Optional(Type.String({ minLength: 36, maxLength: 36 })),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      execute: async (_id, params) => {
        if (!params || typeof params !== "object" || Array.isArray(params))
          throw new Error("Invalid fixed attachment request")
        const { action, sessionId } = params as { action: Action; sessionId?: string }
        if (
          !actions.includes(action) ||
          Object.keys(params).some((key) => key !== "action" && key !== "sessionId") ||
          (action === "open" || action === "list"
            ? sessionId !== undefined
            : typeof sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(sessionId))
        )
          throw new Error("Invalid fixed attachment request")
        if (this.closing) throw new Error("Fixed attachment reader is closing")
        const details = await this.serialize(() => this.request(actor, action, sessionId))
        return { content: [{ type: "text", text: JSON.stringify(details) }], details }
      },
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work)
    this.pending = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private receipt(actor: string, id: string) {
    const found = this.store.find(this.runId, id, actor)
    if (!found) throw missing()
    return found
  }

  private view(row: FixedReadReceipt) {
    const { id: sessionId, ...data } = row
    return { sessionId, ...data }
  }

  private async request(actor: string, action: Action, id?: string) {
    if (action === "list")
      return { sessions: this.store.list(this.runId, actor).map((row) => this.view(row)) }
    if (action === "open") {
      const { receipt, created } = this.store.reserve(this.runId, actor, this.attachment.sample)
      if (!created) return this.view(receipt)
      try {
        const reader = new FixedAttachmentReader(this.sandbox, this.attachment)
        this.readers.set(receipt.id, reader)
        this.store.acknowledge(this.runId, receipt.id, await reader.ready())
        void reader.exited
          .then(() => {
            if (this.readers.get(receipt.id) !== reader) return
            return this.serialize(async () => {
              if (this.readers.get(receipt.id) === reader) this.interrupt(receipt.id)
            })
          })
          .catch(() => {})
      } catch (error) {
        this.interrupt(receipt.id)
        throw error
      }
      return this.view(this.receipt(actor, receipt.id))
    }
    const sessionId = id!
    const receipt = this.receipt(actor, sessionId)
    if (action === "status") return this.view(receipt)
    if (action === "finish") {
      await this.finish(sessionId)
      return this.view(this.receipt(actor, sessionId))
    }
    const window = action === "first" ? 1 : 2
    let bytes = this.store.output(this.runId, sessionId, actor, window)
    if (!bytes) {
      const reader = this.readers.get(sessionId)
      if (!reader || receipt.state !== "reading")
        throw new Error("Fixed reader has no saved output for this window")
      if (receipt.windows !== window - 1) throw new Error("Read the first window before the second")
      try {
        bytes = await reader.read(window)
        this.store.save(this.runId, sessionId, window, bytes)
      } catch (error) {
        this.interrupt(sessionId)
        throw error
      }
    }
    return { ...this.view(this.receipt(actor, sessionId)), output: describeOutput(bytes, window) }
  }

  private interrupt(id: string) {
    const reader = this.readers.get(id)
    this.readers.delete(id)
    reader?.disconnect()
    this.store.end(this.runId, id, false)
  }

  private async finish(id: string) {
    const reader = this.readers.get(id)
    if (!reader) return
    this.readers.delete(id)
    try {
      await reader.finish()
      this.store.end(this.runId, id, true)
    } catch (error) {
      reader.disconnect()
      this.store.end(this.runId, id, false)
      throw error
    }
  }

  closeOwner(owner: string) {
    return this.serialize(async () => {
      for (const row of this.store.list(this.runId, owner)) await this.finish(row.id)
    })
  }

  async close() {
    this.closing = true
    await this.pending
    const results = await Promise.allSettled([...this.readers.keys()].map((id) => this.finish(id)))
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))
    if (errors.length) {
      const causes = errors.map((error) => (error instanceof Error ? error.message : String(error)))
      throw new AggregateError(errors, "Fixed attachment cleanup failed: " + causes.join(", "))
    }
  }
}
