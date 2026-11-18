import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { executeDockerCommand } from "@ctf-agent/sandbox"

const fixture = fileURLToPath(new URL("./fixed-attachments", import.meta.url))
const scriptMount = `type=bind,src=${fixture},dst=/fixture,readonly`
const receiptDirectory = ".fixed-attachment-receipts"
export const fixedReadsRequested = process.env.DOCKER_FIXED_ATTACHMENTS === "1"

export interface FixedReceipt {
  phase: string
  visited?: number[]
  sessions: {
    id: number
    pid: number
    state: string
    exitCode: number | null
    pending?: boolean
    held: boolean
    boots: number
    streams: { bytes: number; sha256: string }[]
  }[]
}

export function fixedSampleMounts(workspace: string, sample: "misc1" | "misc2") {
  return fixedReadsRequested
    ? [
        "--mount",
        scriptMount,
        "--mount",
        `type=bind,src=${join(workspace, "sample.bin")},dst=/samples/${sample}.zip,readonly`,
      ]
    : []
}

export async function startFixedReads(
  box: string,
  workspace: string,
  phase: "failed" | "writeup" | "close",
) {
  const result = await executeDockerCommand(
    ["exec", "--detach", box, "python3", "-I", "-B", "/fixture/project_receipts.py", phase],
    { timeoutMs: 10_000 },
  )
  if (result.code !== 0) throw new Error("Could not start fixed reads: " + result.stderr)
  const ready = join(workspace, receiptDirectory, "ready.json")
  const until = Date.now() + 12_000
  while (Date.now() < until) {
    try {
      const data = JSON.parse(await readFile(ready, "utf8")) as { phase: string }
      if (data.phase !== phase) throw new Error("Unexpected fixed read receipt")
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await sleep(40)
    }
  }
  throw new Error("Fixed reads did not publish their receipt: " + phase)
}

export async function inspectFixedReads(
  image: string,
  workspace: string,
  label: string,
  reconcile = false,
) {
  const receipt = join(workspace, receiptDirectory)
  const mount = `type=bind,src=${receipt},dst=/receipt` + (reconcile ? "" : ",readonly")
  const result = await executeDockerCommand(
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--label",
      label,
      "--mount",
      scriptMount,
      "--mount",
      mount,
      "--entrypoint",
      "python3",
      image,
      "-I",
      "-B",
      "/fixture/project_receipts.py",
      reconcile ? "reconcile" : "inspect",
    ],
    { timeoutMs: 12_000 },
  )
  if (result.code !== 0) throw new Error("Could not inspect fixed read receipts: " + result.stderr)
  return JSON.parse(result.stdout) as FixedReceipt
}
