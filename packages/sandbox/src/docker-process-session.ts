import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  type DockerCommandExecutor,
  executeDockerCommand,
  spawnDockerProcess,
} from "./docker-sandbox.ts"

/**
 * P4-a capability sample (design 12.1, 14.1): one long-running process inside a
 * running container with stdin attached and stdout/stderr kept as raw bytes.
 *
 * Killing the host `docker exec` client does not stop the process in the
 * container (stage 0 probe), so the process runs as its own session leader
 * and `stop()` signals the whole process group from inside the container.
 * Children orphaned by a stop are reparented to the container's PID 1, which
 * only reaps them when the container runs with `--init`; otherwise they stay
 * as zombies and count against `--pids-limit`.
 * This is a feasibility sample, not the P4-b production contract: there is no
 * request-key idempotence, quota, deadline, log persistence, or recovery here.
 */

export interface ProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface StartProcessOptions {
  /** Working directory inside the container. */
  cwd?: string
  /** Injected for tests; defaults to the Docker CLI. */
  executeCommand?: DockerCommandExecutor
  spawnProcess?: (args: readonly string[]) => ChildProcessWithoutNullStreams
}

export interface StopProcessOptions {
  /** Time to wait after SIGTERM before SIGKILL. */
  graceMs?: number
}

// `docker exec` under runc already starts the command as a session and process
// group leader. Plain `setsid` would then fork, and the attached client would
// report the forking parent's exit instead of the command's, so setsid only
// runs when the runtime did not do this. The leader writes its pid (= process
// group id) before exec'ing the command, so stop() can reach every child the
// command starts. $0 carries this script so the setsid branch can re-run it.
const LAUNCHER = [
  "read -r _ _ _ _ group _ < /proc/$$/stat",
  '[ "$group" = "$$" ] || exec setsid sh -c "$0" "$0" "$@"',
  'printf "%s" "$$" > "$1" && cd -- "$2" && exec bash -c "$3"',
].join("\n")

export class DockerProcessSession {
  readonly exited: Promise<ProcessExit>
  private readonly stdoutListeners = new Set<(chunk: Buffer) => void>()
  private readonly stderrListeners = new Set<(chunk: Buffer) => void>()
  private exit?: ProcessExit

  private constructor(
    private readonly containerId: string,
    private readonly pidFile: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly executeCommand: DockerCommandExecutor,
  ) {
    child.stdout.on("data", (chunk: Buffer) => {
      for (const listener of this.stdoutListeners) listener(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      for (const listener of this.stderrListeners) listener(chunk)
    })
    // A write after the process exits must not crash the host.
    child.stdin.on("error", () => undefined)
    this.exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.exit = { code, signal }
        resolve(this.exit)
      })
      child.on("error", () => {
        this.exit = { code: null, signal: null }
        resolve(this.exit)
      })
    })
  }

  static start(
    containerId: string,
    command: string,
    options: StartProcessOptions = {},
  ): DockerProcessSession {
    const pidFile = `/tmp/ctf-process-${randomUUID()}.pid`
    const spawnProcess = options.spawnProcess ?? spawnDockerProcess
    const child = spawnProcess([
      "exec",
      "-i",
      containerId,
      "sh",
      "-c",
      LAUNCHER,
      LAUNCHER,
      pidFile,
      options.cwd ?? "/workspace",
      command,
    ])
    return new DockerProcessSession(
      containerId,
      pidFile,
      child,
      options.executeCommand ?? executeDockerCommand,
    )
  }

  get running(): boolean {
    return this.exit === undefined
  }

  onStdout(listener: (chunk: Buffer) => void): () => void {
    this.stdoutListeners.add(listener)
    return () => this.stdoutListeners.delete(listener)
  }

  onStderr(listener: (chunk: Buffer) => void): () => void {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  /** Write raw bytes to the process stdin; resolves once they are handed to the pipe. */
  write(data: Uint8Array | string): Promise<void> {
    if (!this.running) return Promise.reject(new Error("Process has exited"))
    return new Promise((resolve, reject) => {
      this.child.stdin.write(data, (error) => (error ? reject(error) : resolve()))
    })
  }

  /** Close stdin so the process sees end of input. */
  endInput(): void {
    this.child.stdin.end()
  }

  /** The process group id inside the container, once the launcher has written it. */
  async processGroupId(): Promise<number | undefined> {
    const result = await this.executeCommand(["exec", this.containerId, "cat", this.pidFile])
    const pid = Number(result.stdout.trim())
    return result.code === 0 && Number.isInteger(pid) && pid > 1 ? pid : undefined
  }

  /**
   * Stop the whole process group inside the container: SIGTERM, then SIGKILL
   * after the grace period. Resolves with the exit of the attached client.
   */
  async stop(options: StopProcessOptions = {}): Promise<ProcessExit> {
    if (!this.running) return this.exit as ProcessExit
    const group = await this.processGroupId()
    if (group === undefined) {
      // The launcher never ran far enough to record a group; end the client only.
      this.child.kill("SIGKILL")
      return this.exited
    }
    await this.signalGroup(group, "TERM")
    const graceMs = options.graceMs ?? 2_000
    const settled = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!settled) await this.signalGroup(group, "KILL")
    await this.executeCommand(["exec", this.containerId, "rm", "-f", this.pidFile])
    return this.exited
  }

  private async signalGroup(group: number, signal: "TERM" | "KILL"): Promise<void> {
    await this.executeCommand(["exec", this.containerId, "kill", `-${signal}`, "--", `-${group}`])
  }
}
