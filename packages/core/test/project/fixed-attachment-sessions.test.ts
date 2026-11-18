import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { executeDockerCommand } from "@ctf-agent/sandbox"
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"
import { fixedReadsRequested } from "./fixtures/fixed-attachment-witness.ts"

const samples = {
  misc1: "b4f338efcdd52d870708498d6c06bb3d5fe9755a5575a57e464d32037453ee05",
  misc2: "e4744f33f74a384df4f162898c8b045624bd98a37446079af045b81f42407e66",
} as const
const cases = ["T29", "T30", "T31", "T32", "T33", "T34", "T35", "T36", "T38"] as const
const directory = process.env.DOCKER_CLEANUP_SAMPLES
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

async function docker(args: string[]) {
  const result = await executeDockerCommand(args, { timeoutMs: 45_000 })
  if (result.code !== 0)
    throw new Error("Fixed attachment fixture failed: " + (result.stderr || result.stdout))
  return result.stdout.trim()
}

describe.runIf(process.env.DOCKER_LIVE === "1" && fixedReadsRequested)(
  "fixed offline attachment sessions",
  () => {
    const label = "ctf-agent.test.fixed-attachments=" + randomUUID()
    const mounts: string[] = []
    let image: string
    let streamDigests: string[]
    beforeAll(async () => {
      if (!directory)
        throw new Error("Set DOCKER_CLEANUP_SAMPLES to the pinned misc1/misc2 directory")
      image = await docker(["image", "inspect", "--format", "{{.Id}}", "ctf-agent-solver:latest"])
      expect(image).toMatch(/^sha256:[0-9a-f]{64}$/)
      const fixture = fileURLToPath(new URL("./fixtures/fixed-attachments", import.meta.url))
      mounts.push("--mount", `type=bind,src=${fixture},dst=/fixture,readonly`)
      for (const name of ["misc1", "misc2"] as const) {
        const archive = resolve(directory, name, name + "_attachment.zip")
        const bytes = await readFile(archive)
        expect(digest(bytes)).toBe(samples[name])
        mounts.push("--mount", `type=bind,src=${archive},dst=/samples/${name}.zip,readonly`)
        if (name === "misc2") {
          // Calculate the expected output independently, from the original host bytes.
          const out = Buffer.from([0, 255, 228, 184, 173])
          const err = Buffer.from([254, 0, 240, 159, 140, 141])
          streamDigests = [
            digest(
              Buffer.concat([
                out,
                bytes.subarray(0, 12288),
                Buffer.from("€"),
                out,
                bytes.subarray(16384, 28672),
              ]),
            ),
            digest(
              Buffer.concat([err, bytes.subarray(12288, 16384), err, bytes.subarray(28672, 32768)]),
            ),
          ]
        }
      }
    })

    for (const id of cases) {
      it(
        id + " fixed attachment behavior",
        async () => {
          const output = await docker([
            "run",
            "--rm",
            "--pull=never",
            "--init",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--user=65534:65534",
            "--pids-limit=64",
            "--memory=128m",
            "--stop-timeout=1",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
            "--label",
            label,
            ...mounts,
            "--entrypoint",
            "python3",
            image,
            "-I",
            "-B",
            "/fixture/checks.py",
            id,
          ])
          const receipt = JSON.parse(output) as {
            case: string
            samples: typeof samples
            observations: Record<string, unknown>
          }
          expect(receipt.case).toBe(id)
          expect(receipt.samples).toEqual(samples)
          if (id === "T30") expect(receipt.observations.sha256).toEqual(streamDigests)
          console.info("fixed-attachments", JSON.stringify({ ...receipt, label, image }))
        },
        50_000,
      )
    }

    afterAll(async () => {
      const list = () =>
        docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", "label=" + label])
      const leftover = (await list()).split(/\s+/).filter(Boolean)
      if (leftover.length) {
        for (const id of leftover) expect(id).toMatch(/^[0-9a-f]{64}$/)
        await docker(["rm", "--force", ...leftover])
      }
      expect(await list()).toBe("")
      expect(leftover).toEqual([])
      console.info("fixed-attachments teardown", JSON.stringify({ label, remaining: 0 }))
    })
  },
)
