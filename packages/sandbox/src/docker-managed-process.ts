import { type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFileSync } from "node:fs"
import { spawnDockerProcess } from "./docker-sandbox.ts"

const SUPERVISOR = readFileSync(new URL("./process-supervisor.py", import.meta.url), "utf8")
const MAX_FRAME = 65_536

export interface ManagedProcessExit {
  state: "exited" | "timed_out" | "cancelled" | "interrupted"
  exitCode: number | null
  stopReason: string | null
  stdoutBytes: number
  stderrBytes: number
}

export class DeliveryUnknownError extends Error {
  readonly code = "delivery_unknown"
  constructor(message = "Process input delivery is unknown; do not automatically resend") {
    super(message)
    this.name = "DeliveryUnknownError"
  }
}

export class ProcessStartError extends Error {
  readonly confirmed = true
  constructor(message: string) {
    super(message)
    this.name = "ProcessStartError"
  }
}

/** One Docker exec connection. The supervisor owns the child and its raw logs. */
export class DockerManagedProcess {
  pid?: number
  readonly exited: Promise<ManagedProcessExit | undefined>
  readonly started: Promise<number>
  private readonly child: ChildProcessWithoutNullStreams
  private resolveStarted!: (pid: number) => void
  private rejectStarted!: (error: Error) => void
  private resolveExited!: (exit: ManagedProcessExit | undefined) => void
  private pendingWrite?: {
    seq: number
    resolve: (bytes: number) => void
    reject: (error: Error) => void
  }
  private sequence = 0
  private buffer = ""
  private terminal = false
  private ready = false

  private constructor(
    containerId: string,
    command: string,
    cwd: string,
    sessionId: string,
    deadlineAt: number,
    quotaBytes: number,
    spawnProcess: typeof spawnDockerProcess,
  ) {
    this.started = new Promise((resolve, reject) => {
      this.resolveStarted = resolve
      this.rejectStarted = reject
    })
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve
    })
    this.child = spawnProcess([
      "exec",
      "-i",
      containerId,
      "python3",
      "-u",
      "-c",
      SUPERVISOR,
      command,
      cwd,
      `/ctf-processes/${sessionId}`,
      String(deadlineAt / 1000),
      String(quotaBytes),
    ])
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk))
    this.child.stderr.on("data", () => undefined)
    this.child.stdin.on("error", () => undefined)
    this.child.on("error", (error) => this.finish(error))
    this.child.on("close", () => this.finish())
  }

  static async start(
    containerId: string,
    command: string,
    cwd: string,
    sessionId: string,
    deadlineAt: number,
    quotaBytes: number,
    spawnProcess: typeof spawnDockerProcess = spawnDockerProcess,
  ): Promise<DockerManagedProcess> {
    const process = new DockerManagedProcess(
      containerId,
      command,
      cwd,
      sessionId,
      deadlineAt,
      quotaBytes,
      spawnProcess,
    )
    const timer = setTimeout(() => {
      process.finish(new Error("Supervisor start ACK timed out"))
      process.child.kill("SIGKILL")
    }, 15_000)
    try {
      await process.started
    } finally {
      clearTimeout(timer)
    }
    return process
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_FRAME) {
      this.finish(new Error("Supervisor control frame exceeded limit"))
      this.child.kill("SIGKILL")
      return
    }
    for (;;) {
      const end = this.buffer.indexOf("\n")
      if (end < 0) return
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        this.finish(new Error("Invalid supervisor control frame"))
        this.child.kill("SIGKILL")
        return
      }
      if (frame.type === "started" && Number.isSafeInteger(frame.pid)) {
        this.ready = true
        this.pid = frame.pid as number
        this.resolveStarted(frame.pid as number)
      } else if (frame.type === "start_error") {
        this.finish(
          new ProcessStartError(
            typeof frame.message === "string" ? frame.message : "Supervisor start failed",
          ),
        )
      } else if (frame.type === "ack" && this.pendingWrite?.seq === frame.seq) {
        const pending = this.pendingWrite
        this.pendingWrite = undefined
        pending!.resolve(Number(frame.acceptedBytes))
      } else if (frame.type === "write_error" && this.pendingWrite?.seq === frame.seq) {
        const pending = this.pendingWrite
        this.pendingWrite = undefined
        pending!.reject(new DeliveryUnknownError())
      } else if (frame.type === "exit") {
        const state = frame.state
        if (
          state !== "exited" &&
          state !== "timed_out" &&
          state !== "cancelled" &&
          state !== "interrupted"
        ) {
          this.finish(new Error("Invalid supervisor exit state"))
          return
        }
        this.finish(undefined, {
          state,
          exitCode: typeof frame.exitCode === "number" ? frame.exitCode : null,
          stopReason: typeof frame.stopReason === "string" ? frame.stopReason : null,
          stdoutBytes: Number(frame.stdoutBytes),
          stderrBytes: Number(frame.stderrBytes),
        })
      }
    }
  }

  private finish(error?: Error, exit?: ManagedProcessExit): void {
    if (this.terminal) return
    this.terminal = true
    if (!this.ready)
      this.rejectStarted(error ?? new Error("Supervisor disconnected before start ACK"))
    this.pendingWrite?.reject(new DeliveryUnknownError())
    this.pendingWrite = undefined
    this.resolveExited(exit)
  }

  write(data: Buffer, eof: boolean): Promise<number> {
    if (this.terminal)
      return Promise.reject(new DeliveryUnknownError("Process is no longer connected"))
    if (this.pendingWrite) return Promise.reject(new Error("Another process write is pending"))
    const seq = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pendingWrite = { seq, resolve, reject }
      this.child.stdin.write(
        `${JSON.stringify({ type: "write", seq, data: data.toString("base64"), eof })}\n`,
        (error) => {
          if (error && this.pendingWrite?.seq === seq) {
            this.pendingWrite = undefined
            reject(new DeliveryUnknownError())
          }
        },
      )
    })
  }

  async stop(graceMs: number): Promise<ManagedProcessExit | undefined> {
    if (!this.terminal) {
      this.child.stdin.write(`${JSON.stringify({ type: "stop", graceMs })}\n`)
    }
    const timer = setTimeout(() => {
      this.finish(new Error("Supervisor stop ACK timed out"))
      this.child.kill("SIGKILL")
    }, graceMs + 15_000)
    try {
      return await this.exited
    } finally {
      clearTimeout(timer)
    }
  }
}
