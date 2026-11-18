import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { FixedArchive } from "@ctf-agent/sandbox"

export const FIXED_ATTACHMENT_READS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fixed_attachment_reads (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    sample TEXT NOT NULL CHECK (sample IN ('misc1', 'misc2')),
    state TEXT NOT NULL CHECK (state IN ('reading', 'exited', 'interrupted')),
    pid INTEGER,
    exit_code INTEGER,
    first_output BLOB CHECK (length(first_output) = 16396),
    second_output BLOB CHECK (second_output IS NULL OR (length(second_output) = 16397 AND first_output IS NOT NULL)),
    UNIQUE (run_id, owner)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS register_fixed_attachment_reads AFTER INSERT ON fixed_attachment_reads
  BEGIN
    INSERT OR IGNORE INTO runtime_data_capabilities (name, version) VALUES ('fixed-attachment-reads', 1);
  END;
`

const columns = `id, run_id AS runId, owner, sample, state, pid, exit_code AS exitCode,
  (first_output IS NOT NULL) + (second_output IS NOT NULL) AS windows`

export interface FixedReadReceipt {
  id: string
  runId: string
  owner: string
  sample: FixedArchive
  state: "reading" | "exited" | "interrupted"
  pid: number | null
  exitCode: number | null
  windows: number
}

export type FixedReadStream = "stdout" | "stderr"

export function splitFixedReadOutput(data: Buffer, window: 1 | 2) {
  const split = window === 1 ? 12294 : 12295
  return { stdout: data.subarray(0, split), stderr: data.subarray(split) }
}

export class FixedAttachmentReadStore {
  constructor(private readonly db: DatabaseSync) {}

  reserve(runId: string, owner: string, sample: FixedArchive) {
    const id = randomUUID()
    const created = this.db
      .prepare(`INSERT INTO fixed_attachment_reads (id,run_id,owner,sample,state)
      SELECT ?,?,?,?,'reading'
      WHERE (SELECT COUNT(*) FROM fixed_attachment_reads WHERE run_id=? AND state='reading') < 4
        AND NOT EXISTS (SELECT 1 FROM fixed_attachment_reads WHERE run_id=? AND sample<>?)
      ON CONFLICT(run_id,owner) DO NOTHING`)
      .run(id, runId, owner, sample, runId, runId, sample)
    const receipt = this.db
      .prepare(`SELECT ${columns} FROM fixed_attachment_reads WHERE run_id=? AND owner=?`)
      .get(runId, owner) as unknown as FixedReadReceipt | undefined
    if (!receipt || receipt.sample !== sample) {
      if (
        this.db
          .prepare("SELECT 1 FROM fixed_attachment_reads WHERE run_id=? AND sample<>?")
          .get(runId, sample)
      )
        throw new Error("This Run already has a different pinned archive")
      throw new Error("This Run already has four active fixed readers")
    }
    return { receipt, created: created.changes === 1 }
  }

  find(runId: string, id: string, actor: string) {
    return this.db
      .prepare(`SELECT ${columns} FROM fixed_attachment_reads
      WHERE run_id=? AND id=? AND (owner=? OR ?='solver')`)
      .get(runId, id, actor, actor) as unknown as FixedReadReceipt | undefined
  }

  list(runId: string, actor: string) {
    return this.db
      .prepare(`SELECT ${columns} FROM fixed_attachment_reads
      WHERE run_id=? AND (owner=? OR ?='solver') ORDER BY (state='reading') DESC, rowid DESC LIMIT 32`)
      .all(runId, actor, actor) as unknown as FixedReadReceipt[]
  }

  acknowledge(runId: string, id: string, pid: number) {
    this.db
      .prepare(
        "UPDATE fixed_attachment_reads SET pid=? WHERE run_id=? AND id=? AND state='reading'",
      )
      .run(pid, runId, id)
  }

  save(runId: string, id: string, window: 1 | 2, bytes: Uint8Array) {
    const column = window === 1 ? "first_output" : "second_output"
    const result = this.db
      .prepare(`UPDATE fixed_attachment_reads SET ${column}=? WHERE
      run_id=? AND id=? AND state='reading' AND ${column} IS NULL`)
      .run(bytes, runId, id)
    if (result.changes !== 1) throw new Error("Fixed read receipt could not be saved")
  }

  output(runId: string, id: string, actor: string, window: 1 | 2): Buffer | undefined {
    const column = window === 1 ? "first_output" : "second_output"
    const row = this.db
      .prepare(`SELECT ${column} AS output FROM fixed_attachment_reads
      WHERE run_id=? AND id=? AND (owner=? OR ?='solver')`)
      .get(runId, id, actor, actor)
    return row?.output instanceof Uint8Array ? Buffer.from(row.output) : undefined
  }

  /** Project-scoped operator access to the acknowledged windows and receipt in one snapshot. */
  log(runId: string, id: string, stream: FixedReadStream) {
    const row = this.db
      .prepare(`SELECT ${columns}, first_output AS firstOutput, second_output AS secondOutput
        FROM fixed_attachment_reads WHERE run_id=? AND id=?`)
      .get(runId, id) as
      | (FixedReadReceipt & { firstOutput: Uint8Array | null; secondOutput: Uint8Array | null })
      | undefined
    if (!row) return
    const { firstOutput, secondOutput, ...receipt } = row
    const chunks: Buffer[] = []
    if (firstOutput) chunks.push(splitFixedReadOutput(Buffer.from(firstOutput), 1)[stream])
    if (secondOutput) chunks.push(splitFixedReadOutput(Buffer.from(secondOutput), 2)[stream])
    return { receipt, bytes: Buffer.concat(chunks) }
  }

  end(runId: string, id: string, confirmed: boolean) {
    this.db
      .prepare(
        "UPDATE fixed_attachment_reads SET state=?,exit_code=? WHERE run_id=? AND id=? AND state='reading'",
      )
      .run(confirmed ? "exited" : "interrupted", confirmed ? 0 : null, runId, id)
  }

  recover() {
    // A PID from a previous container or host connection cannot prove an exit.
    this.db
      .prepare("UPDATE fixed_attachment_reads SET state='interrupted' WHERE state='reading'")
      .run()
  }
}
