import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { CtfSolverAgent } from "@ctf-agent/agents"
import type { PlatformConnectOptions } from "@ctf-agent/platform"
import { executeDockerCommand, type FixedArchive } from "@ctf-agent/sandbox"
import { defaultRunSettings, mergeRunSettings } from "../../../src/contracts/run-settings.ts"
import { Project } from "../../../src/project/project.ts"
import { TestPlatformPlugin } from "../../fake-platform.ts"

export async function docker(args: string[]) {
  const result = await executeDockerCommand(args, { timeoutMs: 30_000 })
  if (result.code !== 0) throw new Error(result.stderr || "Docker command failed")
  return result.stdout.trim()
}

export async function archive(name: FixedArchive) {
  const dir = process.env.DOCKER_CLEANUP_SAMPLES
  if (!dir) throw new Error("DOCKER_CLEANUP_SAMPLES is required")
  return readFile(join(dir, name, name + "_attachment.zip"))
}

class LocalArchives extends TestPlatformPlugin {
  override async connect(options: PlatformConnectOptions) {
    const platform = await super.connect(options)
    const bind = platform.bindChallenge.bind(platform)
    platform.bindChallenge = async (name) => {
      if (name !== "misc1" && name !== "misc2") throw new Error("Unknown offline archive")
      const capability = await bind(name)
      const bytes = await archive(name)
      const attachment = { id: "zip", name: name + ".zip", size: bytes.length }
      const info = await capability.getInfo()
      return {
        ...capability,
        getInfo: async () => ({ ...info, attachments: [attachment] }),
        downloadAttachment: async (id) => {
          if (id !== "zip") throw new Error("Unknown offline attachment")
          return { attachment, content: bytes }
        },
        submitFlag: async () => {
          throw new Error("No submissions in this integration test")
        },
      }
    }
    return platform
  }
}

export function fixedReaderProject(
  root: string,
  projectId: string,
  image: string,
  samples: readonly FixedArchive[] = ["misc1", "misc2"],
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Expected a cached image ID")
  return Project.open({
    root,
    config: {
      version: 1,
      project: { id: projectId, name: "Fixed attachment integration" },
      platform: {
        plugin: "test",
        config: {
          challenges: samples.map((id) => ({
            id,
            title: id,
            category: "misc",
            score: 0,
            description: "Read two fixed byte windows.",
            attachments: [],
            flag: "",
          })),
        },
      },
      sandbox: { image, networkMode: "none", privileged: false },
    },
    platforms: [new LocalArchives()],
    runSettings: () =>
      mergeRunSettings(defaultRunSettings(), {
        optimization: { localProcesses: "fixed-attachments" },
      }),
  })
}

export interface ToolReceipt {
  sessionId: string
  runId: string
  owner: string
  sample: FixedArchive
  state: "reading" | "exited" | "interrupted"
  windows: number
  pid: number | null
  exitCode: number | null
  output?: {
    window: number
    stdout: { bytes: number; sha256: string }
    stderr: { bytes: number; sha256: string }
  }
}

export function fixedTool(solver: CtfSolverAgent) {
  const tool = solver.tools.find((item) => item.name === "fixed_attachment_read")
  if (!tool) throw new Error("Fixed reader not installed in the Solver")
  return async (action: string, sessionId?: string) =>
    (await tool.execute("fixture", { action, ...(sessionId && { sessionId }) }))
      .details as ToolReceipt
}

/** Expected dual-stream bytes computed from the input fixture, independently of the reader. */
export function expectedFixedWindow(source: Buffer, window: 1 | 2) {
  const start = (window - 1) * 16384
  const stdout = Buffer.concat([
    ...(window === 2 ? [Buffer.from([0x82, 0xac])] : []),
    Buffer.from([0, 255, 0xe4, 0xb8, 0xad]),
    source.subarray(start, start + 12288),
    ...(window === 1 ? [Buffer.from([0xe2])] : []),
  ])
  const stderr = Buffer.concat([
    Buffer.from([254, 0, 0xf0, 0x9f, 0x8c, 0x8d]),
    source.subarray(start + 12288, start + 16384),
  ])
  return { stdout, stderr }
}
