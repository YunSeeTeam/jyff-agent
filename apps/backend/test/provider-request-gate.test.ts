import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  currentModelRequestScope,
  withModelRequestScope,
  type ModelRequestEvent,
} from "@ctf-agent/agents"
import { gateProviderStream, ProviderRequestGate } from "../src/domain/provider-request-gate.ts"

const context = normalizeContext({ systemPrompt: "test", messages: [], tools: [] })

afterEach(() => {
  vi.useRealTimers()
})

describe("ProviderRequestGate", () => {
  it("T25: shared provider keeps immutable Run identity and blocks accepted queued requests before sending", async () => {
    vi.useFakeTimers()
    const events: ModelRequestEvent[] = []
    const sent: string[] = []
    const source = vi.fn((candidate: Model<Api>) => {
      sent.push(currentModelRequestScope()?.runId ?? "missing")
      return completedStream(message(candidate))
    })
    const stream = gateProviderStream(new ProviderRequestGate({ minimumIntervalMs: 100 }), source)
    const scope = (runId: string) => ({
      projectId: "p",
      challengeId: runId,
      runId,
      executionId: `exec-${runId}`,
      onEvent: (event: ModelRequestEvent) => events.push(event),
    })
    let accepted = false
    const first = withModelRequestScope(scope("first"), () => stream(model("shared", "m"), context))
    const second = withModelRequestScope({ ...scope("second"), canSend: () => !accepted }, () =>
      stream(model("shared", "m"), context),
    )
    await vi.advanceTimersByTimeAsync(0)
    await first.result()
    accepted = true
    await vi.advanceTimersByTimeAsync(100)
    expect((await second.result()).stopReason).toBe("aborted")
    expect(sent).toEqual(["first"])
    expect(
      events.find((event) => event.runId === "second" && event.state === "failed"),
    ).toMatchObject({ executionId: "exec-second", sent: false, usageKnown: true })
    expect(new Set(events.map((event) => event.requestId)).size).toBe(2)
    const third = withModelRequestScope(scope("third"), () => stream(model("shared", "m"), context))
    await vi.advanceTimersByTimeAsync(100)
    await third.result()
    expect(sent).toEqual(["first", "third"])
  })

  it("T26/T27: a non-cooperative stream times out and late tool calls are never forwarded", async () => {
    vi.useFakeTimers()
    const events: ModelRequestEvent[] = []
    const upstream = createAssistantMessageEventStream()
    const source = vi.fn<import("../src/domain/provider-request-gate.ts").ProviderStream>(
      () => upstream,
    )
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 0, requestTimeoutMs: 500, idleTimeoutMs: 50 }),
      source,
    )
    const output = withModelRequestScope(
      { runId: "r", onEvent: (event) => events.push(event) },
      () => stream(model("p", "m"), context),
    )
    const forwarded: unknown[] = []
    const consume = (async () => {
      for await (const event of output) forwarded.push(event)
    })()
    await vi.advanceTimersByTimeAsync(50)
    expect(await output.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("idle"),
    })
    await consume
    expect(source).toHaveBeenCalledOnce()
    expect(source.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, timeoutMs: 500 })
    expect(events.at(-1)).toMatchObject({ sent: true, usageKnown: false, state: "failed" })
    const late = message(model("p", "m"))
    late.content = [
      { type: "toolCall", id: "late", name: "ctf_submit_flag", arguments: { flag: "late" } },
    ]
    upstream.push({ type: "done", reason: "toolUse", message: { ...late, stopReason: "toolUse" } })
    upstream.end(late)
    await vi.advanceTimersByTimeAsync(0)
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]).toMatchObject({ type: "error" })
  })

  it("T26: chunks reset the idle timer but cannot extend the per-request timeout", async () => {
    vi.useFakeTimers()
    const upstream = createAssistantMessageEventStream()
    const partial = message(model("p", "m"))
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 0, requestTimeoutMs: 100, idleTimeoutMs: 50 }),
      () => upstream,
    )
    const output = stream(model("p", "m"), context)
    await vi.advanceTimersByTimeAsync(40)
    upstream.push({ type: "start", partial })
    await vi.advanceTimersByTimeAsync(40)
    upstream.push({ type: "start", partial })
    await vi.advanceTimersByTimeAsync(20)
    expect(await output.result()).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("request, 100ms"),
    })
    upstream.end(partial)
  })

  it("T25: cancelling one in-flight Run does not cancel another Run using the same provider", async () => {
    const controller = new AbortController()
    const hanging = createAssistantMessageEventStream()
    const source = vi.fn((candidate: Model<Api>) =>
      candidate.id === "hanging" ? hanging : completedStream(message(candidate)),
    )
    const stream = gateProviderStream(new ProviderRequestGate({ minimumIntervalMs: 0 }), source)
    const first = withModelRequestScope({ signal: controller.signal, runId: "a" }, () =>
      stream(model("shared", "hanging"), context),
    )
    const second = withModelRequestScope({ runId: "b" }, () =>
      stream(model("shared", "normal"), context),
    )
    await second.result()
    controller.abort()
    expect((await first.result()).stopReason).toBe("aborted")
    expect((await second.result()).stopReason).toBe("stop")
    hanging.end(message(model("shared", "hanging")))
  })

  it("错开同一 Provider 的请求，同时允许不同 Provider 独立启动", async () => {
    vi.useFakeTimers()
    const starts: string[] = []
    const source = (candidate: Model<Api>) => {
      starts.push(`${candidate.provider}:${Date.now()}`)
      return completedStream(message(candidate))
    }
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 1_000, transientCooldownMs: 10_000 }),
      source,
    )
    const first = stream(model("provider-a", "first"), context)
    const second = stream(model("provider-a", "second"), context)
    const independent = stream(model("provider-b", "other"), context)

    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first.result(), independent.result()])
    expect(starts.map((entry) => entry.split(":")[0])).toEqual(["provider-a", "provider-b"])

    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await second.result()
    expect(starts).toHaveLength(3)
  })

  it("一次 Provider 503 会让后续同 Provider 请求共享冷却", async () => {
    vi.useFakeTimers()
    let providerACalls = 0
    const source = (candidate: Model<Api>) => {
      if (candidate.provider === "provider-a") providerACalls++
      return completedStream(
        message(
          candidate,
          candidate.provider === "provider-a" && providerACalls === 1
            ? { stopReason: "error", errorMessage: "503 status code (no body)" }
            : {},
        ),
      )
    }
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 0, transientCooldownMs: 10_000 }),
      source,
    )

    await vi.advanceTimersByTimeAsync(0)
    await stream(model("provider-a", "first"), context).result()
    const cooling = stream(model("provider-a", "second"), context)
    const independent = stream(model("provider-b", "other"), context)

    await vi.advanceTimersByTimeAsync(9_999)
    await independent.result()
    expect(providerACalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await cooling.result()
    expect(providerACalls).toBe(2)
  })

  it("取消等待中的请求不会调用 Provider", async () => {
    vi.useFakeTimers()
    const source = vi.fn((candidate: Model<Api>) => completedStream(message(candidate)))
    const stream = gateProviderStream(
      new ProviderRequestGate({ minimumIntervalMs: 1_000, transientCooldownMs: 10_000 }),
      source,
    )
    await vi.advanceTimersByTimeAsync(0)
    await stream(model("provider-a", "first"), context).result()
    const controller = new AbortController()
    const waiting = stream(model("provider-a", "cancelled"), context, {
      signal: controller.signal,
    })

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    await expect(waiting.result()).resolves.toMatchObject({ stopReason: "aborted" })
    expect(source).toHaveBeenCalledOnce()
  })
})

function model(provider: string, id: string): Model<Api> {
  return {
    api: "openai-completions",
    provider,
    id,
    name: id,
    baseUrl: "https://models.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 8_192,
  }
}

function message(
  candidate: Model<Api>,
  overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: candidate.api,
    provider: candidate.provider,
    model: candidate.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: overrides.stopReason ?? "stop",
    ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
    timestamp: Date.now(),
  }
}

function completedStream(result: AssistantMessage) {
  const stream = createAssistantMessageEventStream()
  stream.end(result)
  return stream
}
