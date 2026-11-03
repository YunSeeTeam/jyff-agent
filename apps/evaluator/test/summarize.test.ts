import { describe, expect, it } from "vite-plus/test"
import type { SampleObservation } from "../src/collect.ts"
import type { SampleOutcome, SampleResult } from "../src/run.ts"
import { emptyUsage } from "../src/session-usage.ts"
import { summarizeResults } from "../src/summarize.ts"

const MINUTE = 60_000
const DISPATCHED = Date.parse("2026-11-02T08:00:00.000Z")

function sample(
  challengeId: string,
  outcome: SampleOutcome,
  options: {
    minutes?: number
    costMicros?: number
    unpriced?: number
    unknownUsage?: number
    group?: string
  } = {},
): SampleResult {
  const usage = { ...emptyUsage(), requests: 1, costMicros: options.costMicros ?? 1_000_000 }
  usage.unpricedRequests = options.unpriced ?? 0
  usage.unknownUsageRequests = options.unknownUsage ?? 0
  const observation = {
    usage,
    rejectedSubmissions: outcome === "not_accepted" ? 1 : 0,
    acceptedWithoutSolvedRun: false,
  } as SampleObservation
  return {
    schemaVersion: 1,
    group: options.group ?? "A-original",
    sampleId: `${challengeId}-${Math.random()}`,
    challengeId,
    repeat: 1,
    order: 1,
    outcome,
    stopReason: "finished",
    startedAt: new Date(DISPATCHED).toISOString(),
    dispatchedAt: outcome === "harness_error" ? null : new Date(DISPATCHED).toISOString(),
    deadlineAt:
      outcome === "harness_error" ? null : new Date(DISPATCHED + 60 * MINUTE).toISOString(),
    stoppedAt: new Date(DISPATCHED + 60 * MINUTE).toISOString(),
    timeToAcceptMs: options.minutes === undefined ? null : options.minutes * MINUTE,
    harnessErrors: [],
    cancel: null,
    backendExit: null,
    leftoverContainers: { found: 0, removed: 0 },
    sampleRoot: "",
    observation: outcome === "harness_error" ? null : observation,
  }
}

describe("summarizeResults", () => {
  it("counts every sample in the denominator and keeps failures in cost", () => {
    const [summary] = summarizeResults(
      [
        sample("a", "accepted", { minutes: 10 }),
        sample("a", "accepted", { minutes: 40 }),
        sample("a", "not_accepted", { costMicros: 3_000_000 }),
        sample("b", "accepted_late", { minutes: 70 }),
        sample("b", "isolation_failed"),
        sample("b", "harness_error"),
      ],
      { resamples: 2_000, seed: 7 },
    )

    expect(summary?.samples).toBe(6)
    expect(summary?.outcomes).toEqual({
      accepted: 2,
      accepted_late: 1,
      not_accepted: 1,
      isolation_failed: 1,
      harness_error: 1,
    })
    expect(summary?.onTimeAcceptance.accepted).toBe(2)
    expect(summary?.onTimeAcceptance.ratio).toBeCloseTo(2 / 6)
    expect(summary?.timeToAcceptMs).toMatchObject({ n: 2, median: 25 * MINUTE })
    expect(summary?.acceptanceCurve).toEqual([
      { fractionOfWallClock: 0.25, ratio: 1 / 6 },
      { fractionOfWallClock: 0.5, ratio: 1 / 6 },
      { fractionOfWallClock: 0.75, ratio: 2 / 6 },
      { fractionOfWallClock: 1, ratio: 2 / 6 },
    ])
    // Five observed samples at 1 USD each plus the 3 USD failure; harness error has none.
    expect(summary?.cost).toMatchObject({ totalUsd: 7, perSampleUsd: 7 / 6, complete: true })
    expect(summary?.perChallenge).toEqual([
      {
        challengeId: "a",
        samples: 3,
        acceptedOnTime: 2,
        medianTimeToAcceptMs: 25 * MINUTE,
        costUsd: 5,
      },
      { challengeId: "b", samples: 3, acceptedOnTime: 0, medianTimeToAcceptMs: null, costUsd: 2 },
    ])
  })

  it("produces a reproducible challenge-clustered interval", () => {
    const results = [
      sample("a", "accepted", { minutes: 5 }),
      sample("a", "accepted", { minutes: 6 }),
      sample("b", "not_accepted"),
      sample("b", "accepted", { minutes: 30 }),
      sample("c", "not_accepted"),
      sample("c", "not_accepted"),
    ]
    const first = summarizeResults(results, { resamples: 2_000, seed: 11 })[0]
    const second = summarizeResults(results, { resamples: 2_000, seed: 11 })[0]

    const ci = first?.onTimeAcceptance.ci95
    expect(ci).toEqual(second?.onTimeAcceptance.ci95)
    expect(ci?.[0]).toBeLessThanOrEqual(first?.onTimeAcceptance.ratio ?? -1)
    expect(ci?.[1]).toBeGreaterThanOrEqual(first?.onTimeAcceptance.ratio ?? 2)
    expect(ci?.[0]).toBeGreaterThanOrEqual(0)
    expect(ci?.[1]).toBeLessThanOrEqual(1)
  })

  it("gives no interval for a single challenge and flags unpriced cost", () => {
    const [summary] = summarizeResults([
      sample("a", "accepted", { minutes: 5, unpriced: 2 }),
      sample("a", "not_accepted"),
    ])
    expect(summary?.onTimeAcceptance.ci95).toBeNull()
    expect(summary?.cost).toMatchObject({ unpricedRequests: 2, complete: false })
  })

  it("treats requests without reported usage as incomplete cost", () => {
    const [summary] = summarizeResults([sample("a", "accepted", { minutes: 5, unknownUsage: 3 })])
    expect(summary?.cost).toMatchObject({
      unpricedRequests: 0,
      unknownUsageRequests: 3,
      complete: false,
    })
  })

  it("summarizes groups separately", () => {
    const summaries = summarizeResults([
      sample("a", "accepted", { minutes: 5, group: "A-original" }),
      sample("a", "not_accepted", { group: "A-fixed" }),
    ])
    expect(summaries.map((item) => [item.group, item.onTimeAcceptance.accepted])).toEqual([
      ["A-original", 1],
      ["A-fixed", 0],
    ])
  })
})
