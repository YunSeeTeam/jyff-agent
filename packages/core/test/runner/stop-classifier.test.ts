import { describe, expect, it } from "vite-plus/test"
import { classifySolverStop } from "../../src/orchestration/stop-classifier.ts"

describe("classifySolverStop", () => {
  it("区分同为 429 的临时限流和免费额度耗尽", () => {
    expect(
      classifySolverStop({
        error: Object.assign(new Error("Rate limit exceeded. Please try again later."), {
          status: 429,
        }),
      }),
    ).toMatchObject({
      kind: "provider_transient",
      retryable: true,
      requiresConfiguration: false,
    })

    expect(
      classifySolverStop({
        error: Object.assign(new Error("Rate limit exceeded. Please try again later."), {
          status: 429,
          type: "FreeUsageLimitError",
        }),
      }),
    ).toMatchObject({
      kind: "authentication_or_configuration",
      retryable: false,
      requiresConfiguration: true,
    })
  })

  it.each([
    [{ error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }, "network_transient"],
    [{ error: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }, "network_transient"],
    [{ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }, "network_transient"],
    [{ error: Object.assign(new Error("rate limited"), { status: 429 }) }, "provider_transient"],
    [{ error: Object.assign(new Error("gateway"), { statusCode: 503 }) }, "provider_transient"],
    [{ error: Object.assign(new Error("overloaded"), { statusCode: 502 }) }, "provider_transient"],
    [
      { error: Object.assign(new Error("You exceeded your current quota"), { status: 429 }) },
      "authentication_or_configuration",
    ],
    [
      {
        error: Object.assign(new Error("Rate limit exceeded. Please try again later."), {
          status: 429,
          type: "FreeUsageLimitError",
        }),
      },
      "authentication_or_configuration",
    ],
    [
      { error: Object.assign(new Error("bad key"), { status: 401 }) },
      "authentication_or_configuration",
    ],
    [
      { error: Object.assign(new Error("forbidden"), { status: 403 }) },
      "authentication_or_configuration",
    ],
  ] as const)("classifies structured external failure %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({
      kind,
      blockDelta: 0,
    })
  })

  it.each([
    [{ error: "socket ECONNRESET" }, "network_transient", true],
    [{ error: "fetch failed" }, "network_transient", true],
    [{ error: "HTTP 502 upstream" }, "provider_transient", true],
    [{ error: "HTTP 503 unavailable" }, "provider_transient", true],
    [{ error: "HTTP 504 gateway timeout" }, "provider_transient", true],
    [{ stopReason: "aborted", error: "Aborted" }, "network_transient", true],
    [{ error: "rate limit exceeded" }, "protocol_or_non_transient", false, 1],
    [{ error: "余额不足，请充值后重试" }, "authentication_or_configuration", false],
    [
      { error: '429: {"type":"FreeUsageLimitError","message":"Rate limit exceeded"}' },
      "authentication_or_configuration",
      false,
    ],
  ])("uses string fallback for %#", (input, kind, retryable, blockDelta = 0) => {
    expect(classifySolverStop(input)).toMatchObject({
      kind,
      blockDelta,
      retryable,
    })
  })

  it.each([
    // OpenAI/Anthropic SDK connection failures reach the scheduler as text only;
    // `Connection error.` is what a DeepSeek socket reset produced in evaluation.
    [{ stopReason: "error", error: "Connection error." }],
    [{ stopReason: "error", error: "Request timed out." }],
    [{ stopReason: "error", error: "terminated" }],
    [{ error: "socket hang up" }],
    [{ error: "other side closed" }],
  ] as const)(
    "retries SDK connection failures with backoff instead of scoring them %#",
    (input) => {
      expect(classifySolverStop(input)).toMatchObject({
        kind: "network_transient",
        blockDelta: 0,
        retryable: true,
      })
    },
  )

  it("reads network codes from the error cause chain", () => {
    const socket = Object.assign(new Error("socket disconnected before TLS"), {
      code: "ECONNRESET",
    })
    expect(
      classifySolverStop({ error: new Error("Connection error.", { cause: socket }) }),
    ).toMatchObject({ kind: "network_transient", blockDelta: 0 })
    expect(
      classifySolverStop({
        error: new Error("stream failed", {
          cause: new Error("fetch", {
            cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }),
          }),
        }),
      }),
    ).toMatchObject({ kind: "network_transient", blockDelta: 0 })
  })

  it("does not treat messages that merely mention termination as network failures", () => {
    expect(
      classifySolverStop({
        stopReason: "error",
        error: "tool process terminated with exit code 1",
      }),
    ).toMatchObject({ kind: "protocol_or_non_transient", blockDelta: 1 })
  })

  it.each([
    [{ stopReason: "stop" }, "model_stop"],
    [{ stopReason: "length" }, "length"],
    [{ stopReason: "error", error: new Error("invalid frame") }, "protocol_or_non_transient"],
    [{ timedOut: true }, "timeout"],
  ] as const)("scores non-transient stop %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({ kind, blockDelta: 1 })
  })

  it.each([
    [{ submitted: true }, "submitted"],
    [{ operatorCancel: true }, "operator_cancel"],
    [{ processShutdown: true }, "process_shutdown"],
  ] as const)("does not score lifecycle control %#", (input, kind) => {
    expect(classifySolverStop(input)).toMatchObject({
      kind,
      blockDelta: 0,
      retryable: false,
    })
  })
})
