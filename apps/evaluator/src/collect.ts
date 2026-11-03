import { stat } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { PricingRate } from "./config.ts"
import {
  addUsage,
  emptyUsage,
  listSessionFiles,
  readSessionUsage,
  type SessionKind,
  type UsageTotals,
} from "./session-usage.ts"

/** Run statuses during which the challenge still owns an agent or sandbox. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "running",
  "blocking",
  "writing_writeup",
])

const MAX_ERROR_TEXT = 2_000
const MAX_MESSAGE_TEXT = 500

export interface RunObservation {
  id: string
  attempt: number
  source: string
  status: string
  closeReason: string | null
  error: string | null
  cleanupError: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Recorded platform verdict; null when absent or the build predates the column. */
  solveOutcome: string | null
  writeupStatus: string | null
}

export interface SubmissionObservation {
  runId: string
  at: string
  status: string
  message: string
}

export interface RunStateSnapshot {
  databaseFound: boolean
  runs: RunObservation[]
  activeRunIds: string[]
  queued: { stage: string; lane: string } | null
  submissions: SubmissionObservation[]
  firstAcceptedAt: string | null
}

export interface SampleObservation extends RunStateSnapshot {
  firstAlreadySolvedAt: string | null
  /** Submissions the platform did not accept (wrong flag, rate limit, unknown). */
  rejectedSubmissions: number
  /** Platform accepted, but no Run ended as solved (e.g. writeup failure overwrote it). */
  acceptedWithoutSolvedRun: boolean
  subagents: { total: number; byStatus: Record<string, number> }
  usage: UsageTotals
  usageByKind: Record<SessionKind, UsageTotals>
  usageByModel: Record<string, UsageTotals>
  sessions: Array<{
    path: string
    kind: SessionKind
    runId?: string
    requests: number
    costMicros: number
    invalidLines: number
  }>
  /** Cross-check only: this table is written only while the Token Usage plugin is enabled. */
  tokenUsageTable: {
    rows: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  return value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value
}

function openReadOnly(path: string): DatabaseSync {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec("PRAGMA busy_timeout = 5000")
    return db
  } catch {
    // A WAL database without a -shm file cannot always be opened read-only;
    // fall back to a connection that SQLite itself refuses to write through.
    const db = new DatabaseSync(path)
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA query_only = ON")
    return db
  }
}

function databasePath(projectStateDirectory: string): string {
  return join(projectStateDirectory, "runs.sqlite")
}

function withDatabase<T>(
  projectStateDirectory: string,
  fallback: T,
  read: (db: DatabaseSync) => T,
): T {
  let db: DatabaseSync
  try {
    db = openReadOnly(databasePath(projectStateDirectory))
  } catch {
    return fallback
  }
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function readSnapshot(db: DatabaseSync, challengeId: string): RunStateSnapshot {
  // Builds before the accepted-fact migration have no outcome columns; read them only
  // when present so one evaluator version can observe every group.
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .map((column) => String(column.name)),
  )
  const optional = ["solve_outcome", "writeup_status"]
    .map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
    .join(", ")
  const runs = db
    .prepare(
      `SELECT id, attempt, source, status, close_reason, error, cleanup_error,
              created_at, started_at, finished_at, ${optional}
         FROM runs WHERE challenge_id = ? ORDER BY attempt`,
    )
    .all(challengeId)
    .map(
      (row): RunObservation => ({
        id: String(row.id),
        attempt: Number(row.attempt),
        source: String(row.source),
        status: String(row.status),
        closeReason: clip(row.close_reason, MAX_ERROR_TEXT),
        error: clip(row.error, MAX_ERROR_TEXT),
        cleanupError: clip(row.cleanup_error, MAX_ERROR_TEXT),
        createdAt: String(row.created_at),
        startedAt: typeof row.started_at === "string" ? row.started_at : null,
        finishedAt: typeof row.finished_at === "string" ? row.finished_at : null,
        solveOutcome: typeof row.solve_outcome === "string" ? row.solve_outcome : null,
        writeupStatus: typeof row.writeup_status === "string" ? row.writeup_status : null,
      }),
    )
  const queueRow = db
    .prepare("SELECT stage, lane FROM scheduler_queue WHERE challenge_id = ?")
    .get(challengeId)
  const submissions = db
    .prepare(
      `SELECT e.run_id, e.data_json, e.created_at
         FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE r.challenge_id = ? AND e.type = 'flag_submitted'
        ORDER BY e.id`,
    )
    .all(challengeId)
    .map((row): SubmissionObservation => {
      let data: { status?: unknown; message?: unknown } = {}
      try {
        data = JSON.parse(String(row.data_json ?? "{}")) as typeof data
      } catch {
        // keep the unknown status below
      }
      return {
        runId: String(row.run_id),
        at: String(row.created_at),
        status: typeof data.status === "string" ? data.status : "unknown",
        message: clip(data.message, MAX_MESSAGE_TEXT) ?? "",
      }
    })
  return {
    databaseFound: true,
    runs,
    activeRunIds: runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id),
    queued: queueRow ? { stage: String(queueRow.stage), lane: String(queueRow.lane) } : null,
    submissions,
    firstAcceptedAt: submissions.find((item) => item.status === "accepted")?.at ?? null,
  }
}

const EMPTY_SNAPSHOT: RunStateSnapshot = {
  databaseFound: false,
  runs: [],
  activeRunIds: [],
  queued: null,
  submissions: [],
  firstAcceptedAt: null,
}

/** Cheap read used while polling a live backend. */
export async function readRunState(
  projectStateDirectory: string,
  challengeId: string,
): Promise<RunStateSnapshot> {
  if (!(await stat(databasePath(projectStateDirectory)).catch(() => undefined))) {
    return EMPTY_SNAPSHOT
  }
  return withDatabase(projectStateDirectory, EMPTY_SNAPSHOT, (db) => readSnapshot(db, challengeId))
}

/** Full read-only observation of one isolated sample. */
export async function collectSample(
  projectStateDirectory: string,
  challengeId: string,
  pricing: Readonly<Record<string, PricingRate>>,
): Promise<SampleObservation> {
  const snapshot = await readRunState(projectStateDirectory, challengeId)
  const tables = snapshot.databaseFound
    ? withDatabase(projectStateDirectory, undefined, (db) => {
        const byStatus: Record<string, number> = {}
        for (const row of db
          .prepare(
            `SELECT s.status AS status, COUNT(*) AS n
               FROM run_subagents s JOIN runs r ON r.id = s.run_id
              WHERE r.challenge_id = ? GROUP BY s.status`,
          )
          .all(challengeId)) {
          byStatus[String(row.status)] = Number(row.n)
        }
        const usage = db
          .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(input_tokens), 0) AS input,
                    COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                    COALESCE(SUM(cache_write_tokens), 0) AS cache_write
               FROM model_token_usage`,
          )
          .get()
        return { byStatus, usage }
      })
    : undefined

  const usage = emptyUsage()
  const usageByKind: Record<SessionKind, UsageTotals> = {
    solver: emptyUsage(),
    subagent: emptyUsage(),
    tldr: emptyUsage(),
  }
  const usageByModel: Record<string, UsageTotals> = {}
  const sessions: SampleObservation["sessions"] = []
  for (const file of await listSessionFiles(projectStateDirectory)) {
    const read = await readSessionUsage(join(projectStateDirectory, file.path), pricing)
    addUsage(usage, read.totals)
    addUsage(usageByKind[file.kind], read.totals)
    for (const [model, totals] of Object.entries(read.byModel)) {
      addUsage((usageByModel[model] ??= emptyUsage()), totals)
    }
    sessions.push({
      ...file,
      requests: read.totals.requests,
      costMicros: read.totals.costMicros,
      invalidLines: read.invalidLines,
    })
  }

  const byStatus = tables?.byStatus ?? {}
  const tableUsage = tables?.usage
  return {
    ...snapshot,
    firstAlreadySolvedAt:
      snapshot.submissions.find((item) => item.status === "already_solved")?.at ?? null,
    rejectedSubmissions: snapshot.submissions.filter(
      (item) => item.status !== "accepted" && item.status !== "already_solved",
    ).length,
    acceptedWithoutSolvedRun:
      snapshot.firstAcceptedAt !== null &&
      !snapshot.runs.some((run) => run.status === "solved" || run.solveOutcome !== null),
    subagents: {
      total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      byStatus,
    },
    usage,
    usageByKind,
    usageByModel,
    sessions,
    tokenUsageTable: {
      rows: Number(tableUsage?.rows ?? 0),
      inputTokens: Number(tableUsage?.input ?? 0),
      outputTokens: Number(tableUsage?.output ?? 0),
      cacheReadTokens: Number(tableUsage?.cache_read ?? 0),
      cacheWriteTokens: Number(tableUsage?.cache_write ?? 0),
    },
  }
}
