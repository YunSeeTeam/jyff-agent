import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export type SolveGoalState = "active" | "paused" | "stopped" | "accepted"

/** Durable solve intent. Request timeouts and individual Runs never finish a goal. */
export interface SolveGoal {
  id: string
  challengeId: string
  state: SolveGoalState
  runId: string | null
  requiresAuto: boolean
  retryAt: string | null
  failures: number
  reason: string | null
  updatedAt: string
}

export const SOLVE_GOALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS solve_goals (
    challenge_id TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'stopped', 'accepted')),
    run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
    requires_auto INTEGER NOT NULL CHECK (requires_auto IN (0, 1)),
    retry_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    reason TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
`

const select = `SELECT id, challenge_id AS challengeId, state, run_id AS runId,
  requires_auto AS requiresAuto, retry_at AS retryAt, failures, reason, updated_at AS updatedAt
  FROM solve_goals`

export class SolveGoalStore {
  constructor(private readonly database: DatabaseSync) {}

  list(): SolveGoal[] {
    return (
      this.database.prepare(`${select} ORDER BY challenge_id`).all() as unknown as SolveGoal[]
    ).map((goal) => ({ ...goal, requiresAuto: Boolean(goal.requiresAuto) }))
  }

  get(challengeId: string): SolveGoal | undefined {
    const goal = this.database
      .prepare(`${select} WHERE challenge_id = ?`)
      .get(challengeId) as unknown as SolveGoal | undefined
    return goal ? { ...goal, requiresAuto: Boolean(goal.requiresAuto) } : undefined
  }

  /** Only an explicit dispatch/start may replace a stopped goal. */
  begin(challengeId: string, requiresAuto: boolean): SolveGoal {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO runtime_data_capabilities (name, version) VALUES ('continuous-solve-goals', 1)",
      )
      .run()
    const current = this.get(challengeId)
    if (current && (current.state === "active" || current.state === "paused")) return current
    this.database
      .prepare(`
      INSERT INTO solve_goals (challenge_id, id, state, run_id, requires_auto, updated_at)
      VALUES (?, ?, 'active', NULL, ?, ?)
      ON CONFLICT(challenge_id) DO UPDATE SET
        id = excluded.id, state = 'active', run_id = NULL,
        requires_auto = excluded.requires_auto, retry_at = NULL, failures = 0, reason = NULL,
        updated_at = excluded.updated_at
    `)
      .run(challengeId, randomUUID(), requiresAuto ? 1 : 0, new Date().toISOString())
    return this.get(challengeId)!
  }

  /** A stale worker cannot revive a manual stop or replace another goal's identity. */
  update(
    id: string,
    patch: Partial<
      Pick<SolveGoal, "state" | "runId" | "requiresAuto" | "retryAt" | "reason" | "failures">
    >,
  ): SolveGoal | undefined {
    const row = this.database.prepare(`${select} WHERE id = ?`).get(id) as unknown as
      | SolveGoal
      | undefined
    if (!row) return undefined
    const current = { ...row, requiresAuto: Boolean(row.requiresAuto) }
    if ((current.state === "stopped" || current.state === "accepted") && patch.state !== "accepted")
      return current
    const next = { ...current, ...patch }
    if (next.runId) {
      const run = this.database
        .prepare("SELECT challenge_id FROM runs WHERE id = ?")
        .get(next.runId)
      if (run?.challenge_id !== current.challengeId)
        throw new Error("Solve goal Run belongs to another challenge")
    }
    this.database
      .prepare(`
      UPDATE solve_goals SET state = ?, run_id = ?, requires_auto = ?, retry_at = ?, reason = ?, failures = ?, updated_at = ?
      WHERE id = ? AND state = ?
    `)
      .run(
        next.state,
        next.runId,
        next.requiresAuto ? 1 : 0,
        next.retryAt,
        next.reason?.slice(0, 2_000) ?? null,
        next.failures,
        new Date().toISOString(),
        id,
        current.state,
      )
    return this.get(current.challengeId)
  }
}
