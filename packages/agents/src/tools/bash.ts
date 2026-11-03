import {
  type BashExecution,
  type BashPrepare,
  type ExecutionEnv,
  getOrThrow,
} from "@ctf-agent/sandbox"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { executeShellWithCapture, type ShellCaptureProgress } from "./shell-output.ts"

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000
const BASH_UPDATE_THROTTLE_MS = 100

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
})

export interface BashToolDetails {
  truncation?: TruncationResult
  fullOutputPath?: string
}

export interface BashToolOptions {
  commandPrefix?: string
  /** Rewrites the command before it runs, e.g. to route it through rtk. */
  prepare?: BashPrepare
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds")
  }
  if (timeout > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`)
  }
}

/**
 * Bash inside the execution environment. `environment` is called once per call
 * so a buffering environment is never shared between parallel tool calls.
 */
export function createBashTool(
  environment: () => ExecutionEnv,
  options: BashToolOptions = {},
): AgentTool<typeof bashSchema, BashToolDetails | undefined> {
  return {
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    async execute(_toolCallId, params: Static<typeof bashSchema>, signal, onUpdate) {
      const { command, timeout } = params
      validateTimeout(timeout)
      const env = environment()
      const execution: BashExecution = {
        command: options.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
        cwd: env.cwd,
        env: {},
        inheritEnv: true,
      }
      await options.prepare?.(execution, signal)
      let latestProgress: (() => ShellCaptureProgress) | undefined
      let updateTimer: NodeJS.Timeout | undefined
      let updateDirty = false
      let lastUpdateAt = 0
      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty || !latestProgress) return
        updateDirty = false
        lastUpdateAt = Date.now()
        const progress = latestProgress()
        onUpdate({
          content: [{ type: "text", text: progress.output }],
          details: {
            truncation: progress.truncation.truncated ? progress.truncation : undefined,
            fullOutputPath: progress.fullOutputPath,
          },
        })
      }
      const clearUpdateTimer = () => {
        if (!updateTimer) return
        clearTimeout(updateTimer)
        updateTimer = undefined
      }
      const scheduleOutputUpdate = () => {
        if (!onUpdate) return
        updateDirty = true
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt)
        if (delay <= 0) {
          clearUpdateTimer()
          emitOutputUpdate()
          return
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined
          emitOutputUpdate()
        }, delay)
      }
      onUpdate?.({ content: [], details: undefined })
      try {
        const capture = getOrThrow(
          await executeShellWithCapture(env, execution.command, {
            cwd: execution.cwd,
            env: execution.env,
            inheritEnv: execution.inheritEnv,
            timeout,
            abortSignal: signal,
            returnExecutionErrors: true,
            onChunk: (_chunk, getProgress) => {
              latestProgress = getProgress
              scheduleOutputUpdate()
            },
          }),
        )
        clearUpdateTimer()
        latestProgress = () => capture
        updateDirty = true
        emitOutputUpdate()
        let outputText = capture.output
        let details: BashToolDetails | undefined
        if (capture.truncation.truncated) {
          details = { truncation: capture.truncation, fullOutputPath: capture.fullOutputPath }
          const startLine = capture.truncation.totalLines - capture.truncation.outputLines + 1
          const endLine = capture.truncation.totalLines
          if (capture.truncation.lastLinePartial) {
            const lastLineSize = formatSize(capture.lastLineBytes)
            outputText += `\n\n[Showing last ${formatSize(capture.truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${capture.fullOutputPath}]`
          } else if (capture.truncation.truncatedBy === "lines") {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines}. Full output: ${capture.fullOutputPath}]`
          } else {
            outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${capture.fullOutputPath}]`
          }
        }
        const appendStatus = (status: string) => `${outputText ? `${outputText}\n\n` : ""}${status}`
        if (capture.cancelled) throw new Error(appendStatus("Command aborted"))
        if (capture.executionError?.code === "timeout") {
          throw new Error(appendStatus(`Command timed out after ${timeout} seconds`), {
            cause: capture.executionError,
          })
        }
        if (capture.executionError) throw capture.executionError
        if (capture.exitCode !== 0 && capture.exitCode !== undefined) {
          throw new Error(appendStatus(`Command exited with code ${capture.exitCode}`))
        }
        return {
          content: [{ type: "text", text: outputText || "(no output)" }],
          details,
        } satisfies AgentToolResult<BashToolDetails | undefined>
      } finally {
        clearUpdateTimer()
      }
    },
  }
}
