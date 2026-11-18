import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"

export const LOCAL_PROCESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS local_process_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    request_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('starting','running','exited','timed_out','cancelled','failed','interrupted')),
    started_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    pid INTEGER,
    exit_code INTEGER,
    stop_reason TEXT,
    cleanup_state TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_state IN ('pending','confirmed','unknown')),
    stdout_bytes INTEGER NOT NULL DEFAULT 0,
    stderr_bytes INTEGER NOT NULL DEFAULT 0,
    allocated_bytes INTEGER NOT NULL DEFAULT 67108864,
    stdin_closed INTEGER NOT NULL DEFAULT 0,
    UNIQUE (run_id, owner, request_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS local_process_run_idx ON local_process_sessions(run_id, id);
  CREATE TRIGGER IF NOT EXISTS register_local_processes AFTER INSERT ON local_process_sessions
  BEGIN
    INSERT OR IGNORE INTO runtime_data_capabilities (name, version) VALUES ('local-processes', 1);
  END;
`

export type LocalProcessState =
  | "starting"
  | "running"
  | "exited"
  | "timed_out"
  | "cancelled"
  | "failed"
  | "interrupted"

export interface LocalProcessReceipt {
  id: string
  runId: string
  owner: string
  requestKey: string
  fingerprint: string
  state: LocalProcessState
  startedAt: string
  deadlineAt: string
  pid: number | null
  exitCode: number | null
  stopReason: string | null
  cleanupState: "pending" | "confirmed" | "unknown"
  stdoutBytes: number
  stderrBytes: number
  allocatedBytes: number
  stdinClosed: boolean
}

const columns = `id, run_id AS runId, owner, request_key AS requestKey, fingerprint,
  state, started_at AS startedAt, deadline_at AS deadlineAt, pid, exit_code AS exitCode,
  stop_reason AS stopReason, cleanup_state AS cleanupState, stdout_bytes AS stdoutBytes,
  stderr_bytes AS stderrBytes, allocated_bytes AS allocatedBytes,
  stdin_closed AS stdinClosed`

const active = "('starting','running')"

export class LocalProcessStore {
  constructor(private readonly db: DatabaseSync) {}

  reserve(input: {
    runId: string
    owner: string
    requestKey: string
    fingerprint: string
    startedAt: string
    deadlineAt: string
  }): { receipt: LocalProcessReceipt; created: boolean } {
    const { runId, owner, requestKey, fingerprint, startedAt, deadlineAt } = input
    const existing = this.db
      .prepare(`SELECT ${columns} FROM local_process_sessions
      WHERE run_id=? AND owner=? AND request_key=?`)
      .get(runId, owner, requestKey) as
      | (Omit<LocalProcessReceipt, "stdinClosed"> & { stdinClosed: number })
      | undefined
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("request_key_conflict")
      return { receipt: { ...existing, stdinClosed: !!existing.stdinClosed }, created: false }
    }
    const id = randomUUID()
    const inserted = this.db
      .prepare(`INSERT INTO local_process_sessions
      (id,run_id,owner,request_key,fingerprint,state,started_at,deadline_at)
      SELECT ?,?,?,?,?,'starting',?,?
      WHERE (SELECT COUNT(*) FROM local_process_sessions WHERE run_id=? AND state IN ${active}) < 4
        AND (?='solver' OR
          (SELECT COUNT(*) FROM local_process_sessions WHERE run_id=? AND owner=? AND state IN ${active}) < 2)
        AND (SELECT COALESCE(SUM(allocated_bytes),0) FROM local_process_sessions WHERE run_id=?) + 67108864 <= 268435456
      ON CONFLICT(run_id,owner,request_key) DO NOTHING`)
      .run(
        id,
        runId,
        owner,
        requestKey,
        fingerprint,
        startedAt,
        deadlineAt,
        runId,
        owner,
        runId,
        owner,
        runId,
      )
    const receipt = this.key(runId, owner, requestKey)
    if (!receipt) throw new Error("local_process_quota")
    if (receipt.fingerprint !== fingerprint) throw new Error("request_key_conflict")
    return { receipt, created: inserted.changes === 1 }
  }

  key(runId: string, owner: string, requestKey: string): LocalProcessReceipt | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM local_process_sessions
      WHERE run_id=? AND owner=? AND request_key=?`)
      .get(runId, owner, requestKey) as
      | (Omit<LocalProcessReceipt, "stdinClosed"> & { stdinClosed: number })
      | undefined
    return row && { ...row, stdinClosed: !!row.stdinClosed }
  }

  find(runId: string, id: string, actor: string): LocalProcessReceipt | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM local_process_sessions
      WHERE run_id=? AND id=? AND (owner=? OR ?='solver')`)
      .get(runId, id, actor, actor) as
      | (Omit<LocalProcessReceipt, "stdinClosed"> & { stdinClosed: number })
      | undefined
    return row && { ...row, stdinClosed: !!row.stdinClosed }
  }

  operatorFind(runId: string, id: string): LocalProcessReceipt | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM local_process_sessions
      WHERE run_id=? AND id=?`)
      .get(runId, id) as
      | (Omit<LocalProcessReceipt, "stdinClosed"> & { stdinClosed: number })
      | undefined
    return row && { ...row, stdinClosed: !!row.stdinClosed }
  }

  list(runId: string, actor: string, after = "", limit = 16) {
    const rows = this.db
      .prepare(`SELECT ${columns} FROM local_process_sessions
      WHERE run_id=? AND (owner=? OR ?='solver') AND id>? ORDER BY id LIMIT ?`)
      .all(runId, actor, actor, after, limit + 1) as unknown as Array<
      Omit<LocalProcessReceipt, "stdinClosed"> & { stdinClosed: number }
    >
    return {
      sessions: rows.slice(0, limit).map((row) => ({ ...row, stdinClosed: !!row.stdinClosed })),
      nextCursor: rows.length > limit ? rows[limit - 1]?.id : undefined,
      omittedCount: rows.length > limit ? this.countAfter(runId, actor, rows[limit - 1]!.id) : 0,
    }
  }

  active(runId: string, owner?: string): LocalProcessReceipt[] {
    const rows = this.db
      .prepare(`SELECT ${columns} FROM local_process_sessions
      WHERE run_id=? AND state IN ${active} AND (? IS NULL OR owner=?) ORDER BY id`)
      .all(runId, owner ?? null, owner ?? null) as unknown as Array<
      Omit<LocalProcessReceipt, "stdinClosed"> & { stdinClosed: number }
    >
    return rows.map((row) => ({ ...row, stdinClosed: !!row.stdinClosed }))
  }

  private countAfter(runId: string, actor: string, after: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM local_process_sessions
      WHERE run_id=? AND (owner=? OR ?='solver') AND id>?`)
      .get(runId, actor, actor, after) as { count: number }
    return row.count
  }

  acknowledge(runId: string, id: string, pid: number): void {
    this.db
      .prepare(`UPDATE local_process_sessions SET state='running',pid=?
      WHERE run_id=? AND id=? AND state='starting'`)
      .run(pid, runId, id)
  }

  finish(
    runId: string,
    id: string,
    input: {
      state: Exclude<LocalProcessState, "starting" | "running">
      exitCode: number | null
      stopReason: string | null
      stdoutBytes: number
      stderrBytes: number
      cleanupState: "confirmed" | "unknown"
    },
  ): void {
    this.db
      .prepare(`UPDATE local_process_sessions SET state=?,exit_code=?,stop_reason=?,
      stdout_bytes=MAX(stdout_bytes,?),stderr_bytes=MAX(stderr_bytes,?),cleanup_state=?,
      allocated_bytes=CASE WHEN ?='confirmed' THEN MAX(stdout_bytes,?)+MAX(stderr_bytes,?)
        ELSE allocated_bytes END
      WHERE run_id=? AND id=? AND state IN ${active}`)
      .run(
        input.state,
        input.exitCode,
        input.stopReason,
        input.stdoutBytes,
        input.stderrBytes,
        input.cleanupState,
        input.cleanupState,
        input.stdoutBytes,
        input.stderrBytes,
        runId,
        id,
      )
  }

  observe(runId: string, id: string, stdoutBytes: number, stderrBytes: number): void {
    this.db
      .prepare(`UPDATE local_process_sessions SET
      stdout_bytes=MAX(stdout_bytes,?),stderr_bytes=MAX(stderr_bytes,?)
      WHERE run_id=? AND id=?`)
      .run(stdoutBytes, stderrBytes, runId, id)
  }

  closeInput(runId: string, id: string): void {
    this.db
      .prepare("UPDATE local_process_sessions SET stdin_closed=1 WHERE run_id=? AND id=?")
      .run(runId, id)
  }

  requestStop(runId: string, id: string): void {
    this.db
      .prepare(`UPDATE local_process_sessions SET stop_reason='stopped'
      WHERE run_id=? AND id=? AND state IN ${active}`)
      .run(runId, id)
  }

  recover(): void {
    this.db
      .prepare(`UPDATE local_process_sessions SET state='interrupted',
      cleanup_state='unknown',exit_code=NULL,stop_reason=COALESCE(stop_reason,'host_crash')
      WHERE state IN ${active}`)
      .run()
  }

  confirmRunCleanup(runId: string): void {
    this.db
      .prepare(`UPDATE local_process_sessions SET cleanup_state='confirmed',
      allocated_bytes=stdout_bytes+stderr_bytes
      WHERE run_id=?`)
      .run(runId)
  }
}
