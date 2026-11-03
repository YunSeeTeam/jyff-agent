import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { PricingRate } from "./config.ts"

export interface UsageTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Known cost in USD micros; unpriced requests add nothing here. */
  costMicros: number
  /** Requests priced by the evaluation pricing table. */
  tablePricedRequests: number
  /** Requests priced by the cost Pi recorded in the session. */
  sessionPricedRequests: number
  /** Requests with tokens but no usable price; total cost is a lower bound when > 0. */
  unpricedRequests: number
  /**
   * Requests that reported no usage at all (streaming usage disabled, aborted
   * request). Their cost is unknown, not zero; total cost is a lower bound when > 0.
   */
  unknownUsageRequests: number
}

export type SessionKind = "solver" | "subagent" | "tldr"

export interface SessionUsage {
  /** Path relative to the Project state directory. */
  path: string
  kind: SessionKind
  runId?: string
  totals: UsageTotals
  byModel: Record<string, UsageTotals>
  invalidLines: number
}

export function emptyUsage(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 0,
    tablePricedRequests: 0,
    sessionPricedRequests: 0,
    unpricedRequests: 0,
    unknownUsageRequests: 0,
  }
}

export function addUsage(target: UsageTotals, source: UsageTotals): void {
  for (const key of Object.keys(target) as Array<keyof UsageTotals>) target[key] += source[key]
}

interface RawUsage {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheWrite?: unknown
  cost?: { total?: unknown }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

function requestUsage(usage: RawUsage, rate: PricingRate | undefined): UsageTotals {
  const totals = emptyUsage()
  totals.requests = 1
  totals.inputTokens = count(usage.input)
  totals.outputTokens = count(usage.output)
  totals.cacheReadTokens = count(usage.cacheRead)
  totals.cacheWriteTokens = count(usage.cacheWrite)
  const tokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  const sessionCost = count(usage.cost?.total)
  if (tokens === 0 && sessionCost === 0) {
    totals.unknownUsageRequests = 1
  } else if (rate) {
    // rate is USD per 1M tokens, so tokens * rate is already USD micros.
    totals.costMicros = Math.round(
      totals.inputTokens * rate.input +
        totals.outputTokens * rate.output +
        totals.cacheReadTokens * rate.cacheRead +
        totals.cacheWriteTokens * rate.cacheWrite,
    )
    totals.tablePricedRequests = 1
  } else if (sessionCost > 0) {
    totals.costMicros = Math.round(sessionCost * 1_000_000)
    totals.sessionPricedRequests = 1
  } else {
    totals.unpricedRequests = 1
  }
  return totals
}

/** Sum provider usage recorded in one Pi JSONL session file. */
export async function readSessionUsage(
  file: string,
  pricing: Readonly<Record<string, PricingRate>>,
): Promise<Pick<SessionUsage, "totals" | "byModel" | "invalidLines">> {
  const totals = emptyUsage()
  const byModel: Record<string, UsageTotals> = {}
  let invalidLines = 0
  let currentModel = "unknown/unknown"
  const lines = (await readFile(file, "utf8")).split("\n")
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      invalidLines += 1
      continue
    }
    let usage: RawUsage | undefined
    let model = currentModel
    if (entry.type === "model_change") {
      currentModel = `${String(entry.provider)}/${String(entry.modelId)}`
      continue
    }
    if (entry.type === "message") {
      const message = entry.message as Record<string, unknown> | undefined
      if (message?.role !== "assistant") continue
      usage = message.usage as RawUsage | undefined
      model = `${String(message.provider)}/${String(message.model)}`
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      usage = entry.usage as RawUsage | undefined
    }
    if (!usage) continue
    const request = requestUsage(usage, pricing[model])
    addUsage(totals, request)
    addUsage((byModel[model] ??= emptyUsage()), request)
  }
  return { totals, byModel, invalidLines }
}

/**
 * Enumerate the session files a Project writes: Solver runs, subagents and the
 * challenge TLDR. Arbitrary *.jsonl files in workspaces are deliberately ignored.
 */
export async function listSessionFiles(
  projectStateDirectory: string,
): Promise<Array<{ path: string; kind: SessionKind; runId?: string }>> {
  const files: Array<{ path: string; kind: SessionKind; runId?: string }> = []
  const exists = async (path: string) =>
    stat(join(projectStateDirectory, path)).then(
      (info) => info.isFile(),
      () => false,
    )
  const runIds = await readdir(join(projectStateDirectory, "runs")).catch(() => [])
  for (const runId of runIds.sort((left, right) => left.localeCompare(right))) {
    const solver = `runs/${runId}/session.jsonl`
    if (await exists(solver)) files.push({ path: solver, kind: "solver", runId })
    const subagents = await readdir(join(projectStateDirectory, "runs", runId, "subagents")).catch(
      () => [],
    )
    for (const id of subagents.sort((left, right) => left.localeCompare(right))) {
      const path = `runs/${runId}/subagents/${id}/session.jsonl`
      if (await exists(path)) files.push({ path, kind: "subagent", runId })
    }
  }
  const challengeKeys = await readdir(join(projectStateDirectory, "challenges")).catch(() => [])
  for (const key of challengeKeys.sort((left, right) => left.localeCompare(right))) {
    const path = `challenges/${key}/workspace/tldr/session.jsonl`
    if (await exists(path)) files.push({ path, kind: "tldr" })
  }
  return files
}
