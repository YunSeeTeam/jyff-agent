import { readFile } from "node:fs/promises"
import type { SampleOutcome, SampleResult } from "./run.ts"

const OUTCOMES: SampleOutcome[] = [
  "accepted",
  "accepted_late",
  "not_accepted",
  "isolation_failed",
  "harness_error",
]

export interface ChallengeSummary {
  challengeId: string
  samples: number
  acceptedOnTime: number
  medianTimeToAcceptMs: number | null
  costUsd: number
}

export interface GroupSummary {
  group: string
  samples: number
  challenges: number
  outcomes: Record<SampleOutcome, number>
  /**
   * Primary metric. The denominator is every sample, so harness errors and
   * isolation failures count as not accepted; investigate them, never drop them.
   */
  onTimeAcceptance: {
    accepted: number
    ratio: number
    /** Challenge-clustered percentile bootstrap; null with fewer than two challenges. */
    ci95: [number, number] | null
    resamples: number
    seed: number
  }
  /** Share of all samples accepted by each fraction of the wall clock. */
  acceptanceCurve: Array<{ fractionOfWallClock: number; ratio: number }>
  /** Among on-time accepted samples only; never a substitute for the ratio above. */
  timeToAcceptMs: { n: number; median: number | null; p90: number | null }
  cost: {
    /** Sum over every sample, failures included. */
    totalUsd: number
    perSampleUsd: number
    unpricedRequests: number
    unknownUsageRequests: number
    /** False when some requests had no price or no usage: totalUsd is a lower bound. */
    complete: boolean
  }
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }
  submissions: { rejected: number; acceptedWithoutSolvedRun: number }
  leftoverContainers: number
  perChallenge: ChallengeSummary[]
}

/** Small deterministic PRNG so bootstrap intervals are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower] ?? 0
  const high = sorted[upper] ?? low
  return low + (high - low) * (position - lower)
}

function clusterBootstrap(
  clusters: ReadonlyArray<{ successes: number; n: number }>,
  resamples: number,
  seed: number,
): [number, number] | null {
  if (clusters.length < 2) return null
  const random = mulberry32(seed)
  const ratios: number[] = []
  for (let i = 0; i < resamples; i += 1) {
    let successes = 0
    let n = 0
    for (let j = 0; j < clusters.length; j += 1) {
      const pick = clusters[Math.floor(random() * clusters.length)]
      if (!pick) continue
      successes += pick.successes
      n += pick.n
    }
    ratios.push(n === 0 ? 0 : successes / n)
  }
  ratios.sort((a, b) => a - b)
  return [quantile(ratios, 0.025) ?? 0, quantile(ratios, 0.975) ?? 0]
}

function wallClockMs(result: SampleResult): number | null {
  if (!result.dispatchedAt || !result.deadlineAt) return null
  return Date.parse(result.deadlineAt) - Date.parse(result.dispatchedAt)
}

function summarizeGroup(
  group: string,
  results: readonly SampleResult[],
  resamples: number,
  seed: number,
): GroupSummary {
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    SampleOutcome,
    number
  >
  const byChallenge = new Map<string, SampleResult[]>()
  for (const result of results) {
    outcomes[result.outcome] += 1
    const list = byChallenge.get(result.challengeId) ?? []
    list.push(result)
    byChallenge.set(result.challengeId, list)
  }

  const onTime = results.filter((result) => result.outcome === "accepted")
  const times = onTime
    .map((result) => result.timeToAcceptMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
  let costMicros = 0
  let unpricedRequests = 0
  let unknownUsageRequests = 0
  let rejected = 0
  let acceptedWithoutSolvedRun = 0
  let leftoverContainers = 0
  for (const result of results) {
    leftoverContainers += result.leftoverContainers.found
    const observation = result.observation
    if (!observation) continue
    costMicros += observation.usage.costMicros
    unpricedRequests += observation.usage.unpricedRequests
    // Absent in results written before this field existed.
    unknownUsageRequests += observation.usage.unknownUsageRequests ?? 0
    tokens.input += observation.usage.inputTokens
    tokens.output += observation.usage.outputTokens
    tokens.cacheRead += observation.usage.cacheReadTokens
    tokens.cacheWrite += observation.usage.cacheWriteTokens
    tokens.requests += observation.usage.requests
    rejected += observation.rejectedSubmissions
    if (observation.acceptedWithoutSolvedRun) acceptedWithoutSolvedRun += 1
  }

  const curve = [0.25, 0.5, 0.75, 1].map((fraction) => {
    const reached = results.filter((result) => {
      const budget = wallClockMs(result)
      return (
        result.outcome === "accepted" &&
        budget !== null &&
        result.timeToAcceptMs !== null &&
        result.timeToAcceptMs <= budget * fraction
      )
    }).length
    return { fractionOfWallClock: fraction, ratio: results.length ? reached / results.length : 0 }
  })

  const perChallenge = [...byChallenge.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([challengeId, list]): ChallengeSummary => {
      const accepted = list.filter((result) => result.outcome === "accepted")
      const challengeTimes = accepted
        .map((result) => result.timeToAcceptMs)
        .filter((value): value is number => value !== null)
        .sort((a, b) => a - b)
      return {
        challengeId,
        samples: list.length,
        acceptedOnTime: accepted.length,
        medianTimeToAcceptMs: quantile(challengeTimes, 0.5),
        costUsd:
          list.reduce((sum, result) => sum + (result.observation?.usage.costMicros ?? 0), 0) /
          1_000_000,
      }
    })

  const totalUsd = costMicros / 1_000_000
  return {
    group,
    samples: results.length,
    challenges: byChallenge.size,
    outcomes,
    onTimeAcceptance: {
      accepted: onTime.length,
      ratio: results.length ? onTime.length / results.length : 0,
      ci95: clusterBootstrap(
        perChallenge.map((item) => ({ successes: item.acceptedOnTime, n: item.samples })),
        resamples,
        seed,
      ),
      resamples,
      seed,
    },
    acceptanceCurve: curve,
    timeToAcceptMs: { n: times.length, median: quantile(times, 0.5), p90: quantile(times, 0.9) },
    cost: {
      totalUsd,
      perSampleUsd: results.length ? totalUsd / results.length : 0,
      unpricedRequests,
      unknownUsageRequests,
      complete: unpricedRequests === 0 && unknownUsageRequests === 0,
    },
    tokens,
    submissions: { rejected, acceptedWithoutSolvedRun },
    leftoverContainers,
    perChallenge,
  }
}

export function summarizeResults(
  results: readonly SampleResult[],
  options: { resamples?: number; seed?: number } = {},
): GroupSummary[] {
  const resamples = options.resamples ?? 10_000
  const seed = options.seed ?? 20_261_102
  const groups = new Map<string, SampleResult[]>()
  for (const result of results) {
    const list = groups.get(result.group) ?? []
    list.push(result)
    groups.set(result.group, list)
  }
  return [...groups.entries()].map(([group, list]) => summarizeGroup(group, list, resamples, seed))
}

export async function readResults(path: string): Promise<SampleResult[]> {
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim())
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as SampleResult
    } catch (error) {
      throw new Error(`${path}:${index + 1} 不是合法 JSON`, { cause: error })
    }
  })
}
