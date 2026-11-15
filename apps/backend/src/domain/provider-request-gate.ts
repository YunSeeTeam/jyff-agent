import { classifySolverStop } from "@ctf-agent/core"
import { randomUUID } from "node:crypto"
import { currentModelRequestScope, type ModelRequestEvent } from "@ctf-agent/agents"
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai"

export const DEFAULT_PROVIDER_REQUEST_INTERVAL_MS = 2_000
export const DEFAULT_PROVIDER_TRANSIENT_COOLDOWN_MS = 15_000

export interface ProviderRequestGateOptions {
  minimumIntervalMs?: number
  transientCooldownMs?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
}

export type ProviderStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream

interface ProviderState {
  nextAllowedAt: number
}

/** Shared start pacing and transient-failure cooldown keyed by model provider. */
export class ProviderRequestGate {
  readonly requestTimeoutMs: number
  readonly idleTimeoutMs: number
  private readonly states = new Map<string, ProviderState>()
  private readonly minimumIntervalMs: number
  private readonly transientCooldownMs: number

  constructor(options: ProviderRequestGateOptions = {}) {
    this.requestTimeoutMs = duration(options.requestTimeoutMs ?? 5 * 60_000, "requestTimeoutMs")
    this.idleTimeoutMs = duration(options.idleTimeoutMs ?? 90_000, "idleTimeoutMs")
    if (!this.requestTimeoutMs || !this.idleTimeoutMs)
      throw new Error("Request timeouts must be positive")
    this.minimumIntervalMs = duration(
      options.minimumIntervalMs ?? DEFAULT_PROVIDER_REQUEST_INTERVAL_MS,
      "minimumIntervalMs",
    )
    this.transientCooldownMs = duration(
      options.transientCooldownMs ?? DEFAULT_PROVIDER_TRANSIENT_COOLDOWN_MS,
      "transientCooldownMs",
    )
  }

  async acquire(provider: string, signal?: AbortSignal): Promise<void> {
    const state = this.state(provider)
    while (true) {
      throwIfAborted(signal)
      const now = Date.now()
      if (now >= state.nextAllowedAt) {
        state.nextAllowedAt = now + this.minimumIntervalMs
        return
      }
      await waitForDelay(state.nextAllowedAt - now, signal)
    }
  }

  observeResult(provider: string, message: AssistantMessage): void {
    const classification = classifySolverStop({
      stopReason: message.stopReason,
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
    })
    if (classification.kind === "provider_transient") this.defer(provider)
  }

  observeError(provider: string, error: unknown): void {
    const classification = classifySolverStop({ stopReason: "error", error })
    if (classification.kind === "provider_transient") this.defer(provider)
  }

  private defer(provider: string): void {
    const state = this.state(provider)
    state.nextAllowedAt = Math.max(state.nextAllowedAt, Date.now() + this.transientCooldownMs)
  }

  private state(provider: string): ProviderState {
    const existing = this.states.get(provider)
    if (existing) return existing
    const state = { nextAllowedAt: 0 }
    this.states.set(provider, state)
    return state
  }
}

export function gateProviderStream(
  gate: ProviderRequestGate,
  source: ProviderStream,
): ProviderStream {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream()
    const scope = currentModelRequestScope()
    const requestId = randomUUID()
    const controller = new AbortController()
    const signals = [controller.signal, options?.signal, scope?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    )
    const signal = AbortSignal.any(signals)
    let sent = false
    let settled = false
    let totalTimer: NodeJS.Timeout | undefined
    let idleTimer: NodeJS.Timeout | undefined
    const notify = (state: ModelRequestEvent["state"], usageKnown: boolean, reason?: string) => {
      try {
        scope?.onEvent?.({
          requestId,
          projectId: scope.projectId,
          challengeId: scope.challengeId,
          runId: scope.runId,
          agentId: scope.agentId,
          executionId: scope.executionId,
          purpose: scope.purpose,
          provider: model.provider,
          model: model.id,
          state,
          sent,
          usageKnown,
          ...(reason ? { reason } : {}),
        })
      } catch {
        /* Observability must not turn a finished request into a duplicate send. */
      }
    }
    const check = () => {
      throwIfAborted(signal)
      if (scope?.canSend?.() === false)
        throw new DOMException("Request cancelled by solve lifecycle", "AbortError")
    }
    const timeout = (kind: string, milliseconds: number) =>
      controller.abort(
        Object.assign(
          new Error(`Request timed out (${kind}, ${milliseconds}ms); provider usage unknown`),
          { code: "ETIMEDOUT" },
        ),
      )
    const resetIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => timeout("idle", gate.idleTimeoutMs), gate.idleTimeoutMs)
    }
    void (async () => {
      let onAbort: (() => void) | undefined
      try {
        check()
        notify("queued", false)
        await gate.acquire(model.provider, signal)
        check() // Acceptance or cancellation while waiting must prevent the actual send.
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(abortReason(signal))
          signal.addEventListener("abort", onAbort, { once: true })
        })
        void aborted.catch(() => {})
        totalTimer = setTimeout(
          () => timeout("request", gate.requestTimeoutMs),
          gate.requestTimeoutMs,
        )
        resetIdle()
        sent = true
        notify("sending", false)
        check()
        const upstream = source(model, context, {
          ...options,
          signal,
          maxRetries: 0,
          timeoutMs: gate.requestTimeoutMs,
        })
        const consume = (async () => {
          for await (const event of upstream) {
            if (settled || signal.aborted) break
            resetIdle()
            output.push(event)
          }
          return upstream.result()
        })()
        const message = await Promise.race([consume, aborted])
        settled = true
        gate.observeResult(model.provider, message)
        notify(
          message.stopReason === "error" || message.stopReason === "aborted"
            ? "failed"
            : "completed",
          message.stopReason !== "error" && message.stopReason !== "aborted",
          message.errorMessage,
        )
        output.end(message)
      } catch (error) {
        settled = true
        const aborted =
          options?.signal?.aborted === true ||
          scope?.signal?.aborted === true ||
          isAbortError(error)
        if (!aborted) gate.observeError(model.provider, error)
        const message = failureMessage(model, error, aborted)
        notify("failed", !sent, message.errorMessage)
        output.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: message,
        })
        output.end(message)
      } finally {
        clearTimeout(totalTimer)
        clearTimeout(idleTimer)
        if (onAbort) signal.removeEventListener("abort", onAbort)
        controller.abort()
      }
    })()
    return output
  }
}

function failureMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  }
}

function duration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负有限数`)
  return value
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal ? abortReason(signal) : new DOMException("aborted", "AbortError"))
    }
    function finish() {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
