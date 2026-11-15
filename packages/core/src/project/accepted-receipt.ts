import { createHash } from "node:crypto"
import { open, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { FlagSubmission } from "@ctf-agent/platform"
import type { RunStore } from "../persistence/run-store.ts"

const file = "accepted-receipt.json"
interface Receipt {
  schemaVersion: 1
  projectId: string
  challengeId: string
  runId: string
  status: "accepted" | "already_solved"
  observedAt: string
  message: string
}

function checksum(receipt: Receipt): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex")
}

/** Journal the actual response before SQLite; no candidate flag or credentials are stored. */
export async function persistAcceptedReceipt(
  directory: string,
  identity: Pick<Receipt, "projectId" | "challengeId" | "runId">,
  submission: FlagSubmission,
  observedAt: string,
): Promise<void> {
  if (submission.status !== "accepted" && submission.status !== "already_solved") return
  const receipt: Receipt = {
    schemaVersion: 1,
    ...identity,
    status: submission.status,
    observedAt,
    message: submission.message.slice(0, 500),
  }
  const temporary = join(directory, `${file}.${process.pid}.tmp`)
  try {
    const handle = await open(temporary, "w", 0o600)
    try {
      await handle.writeFile(JSON.stringify({ receipt, sha256: checksum(receipt) }) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(directory, file))
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Recover only an identity-matching, intact local receipt; platform solved state is not attribution. */
export async function recoverAcceptedReceipts(
  store: RunStore,
  stateDirectory: string,
  projectId: string,
): Promise<void> {
  for (const run of store.listRuns()) {
    if (run.solveOutcome) continue
    let raw: string
    try {
      raw = await readFile(join(stateDirectory, "runs", run.id, file), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    try {
      const { receipt, sha256 } = JSON.parse(raw) as { receipt: Receipt; sha256: string }
      if (
        !receipt ||
        receipt.schemaVersion !== 1 ||
        receipt.projectId !== projectId ||
        receipt.runId !== run.id ||
        receipt.challengeId !== run.challengeId ||
        !["accepted", "already_solved"].includes(receipt.status) ||
        typeof receipt.observedAt !== "string" ||
        !Number.isFinite(Date.parse(receipt.observedAt)) ||
        typeof receipt.message !== "string" ||
        checksum(receipt) !== sha256
      ) {
        throw new Error("Acceptance receipt identity/checksum is invalid")
      }
      store.recordSolveOutcome({
        runId: run.id,
        outcome: receipt.status,
        observedAt: receipt.observedAt,
        message: receipt.message,
      })
      store.appendEvent(run.id, "accepted_receipt_recovered", {
        observedAt: receipt.observedAt,
        outcome: receipt.status,
      })
    } catch (error) {
      store.appendEvent(run.id, "accepted_receipt_recovery_failed", {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
