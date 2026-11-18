import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, stat } from "node:fs/promises"
import { join, posix } from "node:path"
import {
  DockerManagedProcess,
  ProcessStartError,
  type DockerSandbox,
  type ManagedProcessExit,
} from "@ctf-agent/sandbox"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { Type } from "typebox"
import type { LocalProcessReceipt, LocalProcessStore } from "../persistence/local-processes.ts"
import {
  EvidenceError,
  readArtifactRange,
  readBufferArtifactRange,
  type ArtifactRangeQuery,
} from "./artifact-range-reader.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SESSION_LIMIT = 64 * 1024 * 1024
const MAX_PAGE = 32768
const MAX_ENVELOPE = 256 * 1024
const DEFAULT_DEADLINE = 300000
const missing = () => new Error("Process session not found in this scope")
const active = (state: string) => state === "starting" || state === "running"

export type ProcessStream = "stdout" | "stderr"

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const number = value === undefined ? fallback : value
  if (!Number.isSafeInteger(number) || (number as number) < 0 || (number as number) > maximum)
    throw new Error(`Invalid ${label}`)
  return number as number
}

function view(row: LocalProcessReceipt) {
  const { fingerprint: _fingerprint, requestKey: _requestKey, ...safe } = row
  return { sessionId: safe.id, ...safe, id: undefined }
}

/** Run-scoped process tools. The caller, never the model, supplies actor identity. */
export class LocalProcessManager {
  private readonly sessions = new Map<string, DockerManagedProcess>()
  private readonly launching = new Set<Promise<void>>()
  private readonly launches = new Map<string, Promise<void>>()
  private closing?: Promise<void>

  constructor(
    private readonly runId: string,
    private readonly store: LocalProcessStore,
    private readonly sandbox: DockerSandbox,
    private readonly logRoot: string,
    private readonly sessionLimitBytes = SESSION_LIMIT,
  ) {
    if (
      !Number.isSafeInteger(sessionLimitBytes) ||
      sessionLimitBytes < 1 ||
      sessionLimitBytes > SESSION_LIMIT
    )
      throw new Error("Invalid process log quota")
  }

  tools(actor: string): AgentTool[] {
    const sessionId = Type.String({ pattern: UUID.source })
    const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
      Type.Object(properties, { additionalProperties: false })
    return [
      this.tool(
        "process_start",
        "Start a persistent Run-scoped process. requestKey makes starts idempotent. Pipes only; use process_poll for raw output.",
        object({
          requestKey: Type.String({ minLength: 1, maxLength: 128 }),
          command: Type.String({ minLength: 1, maxLength: 8192 }),
          cwd: Type.Optional(Type.String({ maxLength: 1024 })),
          mode: Type.Optional(Type.Union([Type.Literal("pipes"), Type.Literal("pty")])),
          yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
          deadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })),
        }),
        actor,
        (params) => this.start(actor, params),
      ),
      this.tool(
        "process_poll",
        "Read bounded stdout/stderr pages using raw byte offsets. Base64 preserves binary output. Poll cancellation only cancels the wait.",
        object({
          sessionId,
          stdoutOffset: Type.Optional(Type.Integer({ minimum: 0 })),
          stderrOffset: Type.Optional(Type.Integer({ minimum: 0 })),
          limitBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
          waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
          encoding: Type.Optional(Type.Union([Type.Literal("base64"), Type.Literal("utf8")])),
        }),
        actor,
        (params, signal) => this.poll(actor, params, signal),
      ),
      this.tool(
        "process_write",
        "Write exact text or base64 bytes to stdin. No newline is added. A lost ACK means delivery_unknown; do not automatically resend.",
        object({
          sessionId,
          text: Type.Optional(Type.String()),
          base64: Type.Optional(Type.String()),
          eof: Type.Optional(Type.Boolean()),
        }),
        actor,
        (params) => this.write(actor, params),
      ),
      this.tool(
        "process_stop",
        "Stop the process group, then return its observed state. Stopping a terminal session is idempotent.",
        object({
          sessionId,
          graceMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
        }),
        actor,
        (params) => this.stop(actor, params),
      ),
      this.tool(
        "process_list",
        "List bounded session metadata available in this Run; use a cursor for more.",
        object({
          cursor: Type.Optional(Type.String({ pattern: UUID.source })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        }),
        actor,
        (params) => this.list(actor, params),
      ),
    ]
  }

  private tool(
    name: string,
    description: string,
    parameters: ReturnType<typeof Type.Object>,
    _actor: string,
    run: (params: Record<string, unknown>, signal?: AbortSignal) => unknown,
  ): AgentTool {
    return {
      name,
      label: name,
      description,
      parameters,
      executionMode: "sequential",
      execute: async (_id, input, signal) => {
        if (this.closing) throw new Error("Process manager is closing")
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Invalid process request")
        const details = await run(input as Record<string, unknown>, signal)
        const text = JSON.stringify(details)
        if (Buffer.byteLength(text) > (name === "process_list" ? 16 * 1024 : MAX_ENVELOPE))
          throw new Error("Process response exceeded limit")
        return { content: [{ type: "text", text }], details }
      },
    }
  }

  private receipt(actor: string, id: unknown): LocalProcessReceipt {
    if (typeof id !== "string" || !UUID.test(id)) throw missing()
    const row = this.store.find(this.runId, id, actor)
    if (!row) throw missing()
    return row
  }

  private async start(actor: string, input: Record<string, unknown>) {
    const { requestKey, command } = input
    if (
      typeof requestKey !== "string" ||
      requestKey.length < 1 ||
      requestKey.length > 128 ||
      typeof command !== "string" ||
      command.length < 1 ||
      command.length > 8192 ||
      command.includes("\0")
    )
      throw new Error("Invalid process start request")
    const mode = input.mode ?? "pipes"
    if (mode !== "pipes") throw new Error("unsupported_mode")
    const rawCwd = input.cwd ?? "/workspace"
    if (typeof rawCwd !== "string" || rawCwd.includes("\0")) throw new Error("Invalid cwd")
    const cwd = posix.resolve("/workspace", rawCwd)
    if (cwd !== "/workspace" && !cwd.startsWith("/workspace/"))
      throw new Error("cwd_outside_workspace")
    const deadlineMs = boundedInteger(input.deadlineMs, DEFAULT_DEADLINE, 3600000, "deadlineMs")
    if (deadlineMs < 1) throw new Error("Invalid deadlineMs")
    const yieldMs = boundedInteger(input.yieldMs, 1000, 10000, "yieldMs")
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([command, cwd, mode, deadlineMs]))
      .digest("hex")
    const now = Date.now()
    const { receipt, created } = this.store.reserve({
      runId: this.runId,
      owner: actor,
      requestKey,
      fingerprint,
      startedAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + deadlineMs).toISOString(),
    })
    if (!created) return view(receipt)
    const launch = this.launch(receipt, command, cwd)
    this.launching.add(launch)
    this.launches.set(receipt.id, launch)
    void launch.then(
      () => {
        this.launching.delete(launch)
        this.launches.delete(receipt.id)
      },
      () => {
        this.launching.delete(launch)
        this.launches.delete(receipt.id)
      },
    )
    await Promise.race([launch, new Promise((resolve) => setTimeout(resolve, yieldMs))])
    return view(this.receipt(actor, receipt.id))
  }

  private async launch(row: LocalProcessReceipt, command: string, cwd: string): Promise<void> {
    const id = row.id
    if (Date.now() >= Date.parse(row.deadlineAt)) {
      this.store.finish(this.runId, id, {
        state: "timed_out",
        exitCode: null,
        stopReason: "deadline_before_start",
        stdoutBytes: 0,
        stderrBytes: 0,
        cleanupState: "confirmed",
      })
      return
    }
    try {
      const transport = await DockerManagedProcess.start(
        this.sandbox.id,
        command,
        cwd,
        id,
        Date.parse(row.deadlineAt),
        this.sessionLimitBytes,
      )
      this.sessions.set(id, transport)
      this.store.acknowledge(this.runId, id, transport.pid!)
      void transport.exited
        .then(async (exit) => {
          this.sessions.delete(id)
          await this.recordExit(id, exit)
        })
        .catch(() => undefined)
    } catch (error) {
      // No start ACK: the child might already exist. Never retry this key.
      this.store.finish(this.runId, id, {
        state: error instanceof ProcessStartError ? "failed" : "interrupted",
        exitCode: null,
        stopReason: error instanceof ProcessStartError ? "start_failed" : "start_unknown",
        stdoutBytes: 0,
        stderrBytes: 0,
        cleanupState: error instanceof ProcessStartError ? "confirmed" : "unknown",
      })
    }
  }

  private async recordExit(id: string, exit: ManagedProcessExit | undefined): Promise<void> {
    const lengths = await this.lengths(id)
    this.store.finish(this.runId, id, {
      state: exit?.state ?? "interrupted",
      exitCode: exit?.exitCode ?? null,
      stopReason: exit?.stopReason ?? "transport_lost",
      ...lengths,
      cleanupState: exit ? "confirmed" : "unknown",
    })
  }

  private async lengths(id: string) {
    const length = async (stream: ProcessStream) => {
      try {
        const path = join(this.logRoot, id, `${stream}.bin`)
        const info = await stat(path)
        return info.isFile() ? info.size : 0
      } catch {
        return 0
      }
    }
    return { stdoutBytes: await length("stdout"), stderrBytes: await length("stderr") }
  }

  private async page(
    id: string,
    stream: ProcessStream,
    length: number,
    query: ArtifactRangeQuery,
    growing: boolean,
  ) {
    if (!length) return readBufferArtifactRange(Buffer.alloc(0), query)
    const directory = join(this.logRoot, id)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Process log directory changed")
    const path = join(directory, `${stream}.bin`)
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const actual = await file.stat()
      const pathname = await lstat(path)
      if (!actual.isFile() || actual.ino !== pathname.ino || actual.dev !== pathname.dev)
        throw new Error("Process log changed")
      const byteLength = Math.min(length, actual.size)
      try {
        return await readArtifactRange(file, byteLength, query)
      } catch (error) {
        if (
          !(error instanceof EvidenceError) ||
          error.code !== "invalid_encoding" ||
          query.encoding !== "utf8" ||
          !growing ||
          (query.offset ?? 0) + (query.limitBytes ?? 8192) < byteLength
        )
          throw error
        const raw = await readArtifactRange(file, byteLength, { ...query, encoding: "base64" })
        let content: string
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Buffer.from(raw.content, "base64"),
            { stream: true },
          )
        } catch {
          throw error
        }
        const nextOffset = raw.offset + Buffer.byteLength(content, "utf8")
        return {
          encoding: "utf8" as const,
          content,
          byteLength,
          offset: raw.offset,
          nextOffset,
          hasMore: nextOffset < byteLength,
        }
      }
    } finally {
      await file.close()
    }
  }

  private async poll(actor: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const receipt = this.receipt(actor, input.sessionId)
    const stdoutOffset = boundedInteger(
      input.stdoutOffset,
      0,
      Number.MAX_SAFE_INTEGER,
      "stdoutOffset",
    )
    const stderrOffset = boundedInteger(
      input.stderrOffset,
      0,
      Number.MAX_SAFE_INTEGER,
      "stderrOffset",
    )
    const limit = boundedInteger(input.limitBytes, 8192, MAX_PAGE, "limitBytes")
    if (!limit) throw new Error("Invalid limitBytes")
    const waitMs = boundedInteger(input.waitMs, 0, 10000, "waitMs")
    const encoding = input.encoding ?? "base64"
    if (encoding !== "base64" && encoding !== "utf8") throw new Error("Invalid encoding")
    let lengths = await this.lengths(receipt.id)
    const until = Date.now() + waitMs
    while (
      waitMs &&
      Date.now() < until &&
      !signal?.aborted &&
      lengths.stdoutBytes <= stdoutOffset &&
      lengths.stderrBytes <= stderrOffset &&
      active(this.receipt(actor, receipt.id).state)
    ) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now())))
      lengths = await this.lengths(receipt.id)
    }
    this.store.observe(this.runId, receipt.id, lengths.stdoutBytes, lengths.stderrBytes)
    const growing = active(this.receipt(actor, receipt.id).state)
    const stdoutAvailable = lengths.stdoutBytes > stdoutOffset
    const stderrAvailable = lengths.stderrBytes > stderrOffset
    const stdoutLimit =
      stdoutAvailable && stderrAvailable
        ? Math.max(1, Math.floor(limit / 2))
        : stdoutAvailable
          ? limit
          : 1
    const stdout = await this.page(
      receipt.id,
      "stdout",
      lengths.stdoutBytes,
      {
        offset: stdoutOffset,
        limitBytes: stdoutLimit,
        encoding,
      },
      growing,
    )
    const remaining = limit - (stdout.nextOffset - stdout.offset)
    if (stderrOffset > lengths.stderrBytes) throw new Error("Invalid stderrOffset")
    const stderr = remaining
      ? await this.page(
          receipt.id,
          "stderr",
          lengths.stderrBytes,
          {
            offset: stderrOffset,
            limitBytes: remaining,
            encoding,
          },
          growing,
        )
      : {
          offset: stderrOffset,
          nextOffset: stderrOffset,
          byteLength: lengths.stderrBytes,
          hasMore: stderrOffset < lengths.stderrBytes,
          encoding,
          content: "",
        }
    return {
      ...view(this.receipt(actor, receipt.id)),
      stdout,
      stderr,
      pending:
        !!signal?.aborted ||
        (growing &&
          ((!stdoutAvailable && !stderrAvailable) ||
            (stdout.hasMore && stdout.nextOffset === stdout.offset) ||
            (stderr.hasMore && stderr.nextOffset === stderr.offset))),
    }
  }

  private async write(actor: string, input: Record<string, unknown>) {
    const row = this.receipt(actor, input.sessionId)
    if (
      row.stdinClosed &&
      input.eof === true &&
      input.text === undefined &&
      input.base64 === undefined
    )
      return { ...view(row), acceptedBytes: 0 }
    if (row.state !== "running" || row.stdinClosed) throw new Error("Process stdin is unavailable")
    if (input.text !== undefined && input.base64 !== undefined)
      throw new Error("text and base64 are exclusive")
    if (input.eof !== undefined && typeof input.eof !== "boolean") throw new Error("Invalid eof")
    let bytes: Buffer
    if (typeof input.text === "string") bytes = Buffer.from(input.text, "utf8")
    else if (
      typeof input.base64 === "string" &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(input.base64) &&
      input.base64.length % 4 === 0
    )
      bytes = Buffer.from(input.base64, "base64")
    else if (input.text === undefined && input.base64 === undefined) bytes = Buffer.alloc(0)
    else throw new Error("Invalid process input")
    if (bytes.length > 16384 || (!bytes.length && input.eof !== true))
      throw new Error("Invalid process input size")
    const transport = this.sessions.get(row.id)
    if (!transport) throw new Error("delivery_unknown")
    const acceptedBytes = await transport.write(bytes, input.eof === true)
    if (input.eof === true) this.store.closeInput(this.runId, row.id)
    return { ...view(this.receipt(actor, row.id)), acceptedBytes }
  }

  private async stop(actor: string, input: Record<string, unknown>) {
    let row = this.receipt(actor, input.sessionId)
    const graceMs = boundedInteger(input.graceMs, 2000, 10000, "graceMs")
    if (!active(row.state)) return view(row)
    this.store.requestStop(this.runId, row.id)
    if (row.state === "starting") {
      await this.launches.get(row.id)
      row = this.receipt(actor, row.id)
      if (!active(row.state)) return view(row)
    }
    const transport = this.sessions.get(row.id)
    if (!transport) {
      this.store.finish(this.runId, row.id, {
        state: "interrupted",
        exitCode: null,
        stopReason: "transport_lost",
        stdoutBytes: row.stdoutBytes,
        stderrBytes: row.stderrBytes,
        cleanupState: "unknown",
      })
    } else {
      const exit = await transport.stop(graceMs)
      await this.recordExit(row.id, exit)
    }
    return view(this.receipt(actor, row.id))
  }

  private list(actor: string, input: Record<string, unknown>) {
    if (
      input.cursor !== undefined &&
      (typeof input.cursor !== "string" || !UUID.test(input.cursor))
    )
      throw new Error("Invalid cursor")
    const limit = boundedInteger(input.limit, 16, 32, "limit")
    if (!limit) throw new Error("Invalid limit")
    const page = this.store.list(
      this.runId,
      actor,
      (input.cursor as string | undefined) ?? "",
      limit,
    )
    return { ...page, sessions: page.sessions.map(view) }
  }

  async closeOwner(owner: string): Promise<void> {
    const results = await Promise.allSettled(
      this.store.active(this.runId, owner).map((row) => this.stop(owner, { sessionId: row.id })),
    )
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length) throw new AggregateError(failures, "Owner process cleanup failed")
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled(this.launching)
      const rows = this.store.active(this.runId)
      const results = await Promise.allSettled(
        rows.map((row) => this.stop("solver", { sessionId: row.id })),
      )
      const failures = results.filter((result) => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures, "Process cleanup failed")
    })()
    return this.closing
  }
}
