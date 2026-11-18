// Disposable owner for the opt-in Docker recovery test. The parent supplies an
// isolated data root and a local image ID. Nothing here starts a model.
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DockerSandbox, executeDockerCommand } from "@ctf-agent/sandbox"
import { RunStore } from "../../../src/persistence/run-store.ts"
import { challengeWorkspacePath } from "../../../src/project/challenge-workspace.ts"
import { RunEvidence } from "../../../src/project/experiment-record.ts"

const [root, projectId, image, failed, writeup] = process.argv.slice(2)
if (!root || !projectId || !image || !failed || !writeup)
  throw new Error("Missing fixture arguments")
const state = join(root, ".ctf-agent")
const store = await RunStore.open(join(state, "runs.sqlite"))
const evidence = new RunEvidence(state, store)
const containers: string[] = []
const hashes: string[] = []
let exitedExperimentId = ""
let unknownExperimentId = ""
const acceptedAt = "2026-01-10T12:00:00.000Z"
for (const [index, runId] of [failed, writeup].entries()) {
  const challengeId = index === 0 ? "misc1" : "misc2"
  const workspace = challengeWorkspacePath(state, challengeId)
  await mkdir(join(state, "runs", runId), { recursive: true })
  store.createRun({ id: runId, challengeId, workspace, attempt: 1 })
  store.setSandboxCleanupPending(runId, true)
  const box = await DockerSandbox.create(
    { projectId, runId, image, workspace, networkMode: "none", privileged: false },
    (args, options) =>
      executeDockerCommand(
        args[0] === "create"
          ? [
              "create",
              "--pull=never",
              "--label",
              "ctf-agent.test.cleanup=" + projectId,
              ...args.slice(1),
            ]
          : args,
        { timeoutMs: 30_000, ...options },
      ),
  )
  containers.push(box.id)
  const digest = await box.exec(["sha256sum", "/workspace/sample.bin"])
  if (digest.code !== 0) throw new Error("The sample is not readable in the sandbox")
  hashes.push(digest.stdout.split(/\s+/)[0]!)
  const input = await evidence.capture(runId, {
    path: "sample.bin",
    expectedSha256: hashes[index],
  })
  if (index === 0) {
    // This already-finished command and the idle container have distinct lifetimes.
    const completed = await box.exec(["false"])
    if (completed.code !== 1) throw new Error("Expected a known nonzero exit")
    exitedExperimentId = (
      await evidence.record(runId, {
        inputRefs: [input.refId],
        status: "exited",
        exitCode: completed.code,
      })
    ).id
    store.updateRun(runId, {
      status: "failed",
      closeReason: "failed",
      error: "original fixture failure",
      cleanupError: "cleanup unconfirmed",
    })
  } else {
    // The owner will die without observing an exit for this container.
    unknownExperimentId = (
      await evidence.record(runId, { inputRefs: [input.refId], status: "unknown" })
    ).id
    // Pre-existing receipt in test data. No submission or judge connection.
    store.recordSolveOutcome({ runId, outcome: "accepted", observedAt: acceptedAt })
    store.updateRun(runId, { status: "writing_writeup" })
  }
}
await writeFile(
  join(root, "owner-ready.json"),
  JSON.stringify({
    pid: process.pid,
    containers,
    hashes,
    exitedExperimentId,
    unknownExperimentId,
    acceptedAt,
  }),
  { flag: "wx", flush: true },
)
// Leave both containers and the open SQLite connection behind. Recovery runs
// in a different OS process, without the owner's in-memory Sandbox handles.
process.kill(process.pid, "SIGKILL")
