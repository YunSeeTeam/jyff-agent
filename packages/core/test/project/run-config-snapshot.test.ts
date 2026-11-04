import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandResult, Sandbox, SandboxExecOptions } from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { defaultRunSettings, mergeRunSettings } from "../../src/contracts/index.ts"
import { Project } from "../../src/project/project.ts"
import {
  buildRunConfigSnapshot,
  canonicalJson,
  type RunConfigSnapshot,
  runConfigHash,
} from "../../src/project/run-config-snapshot.ts"
import { testPlatform } from "../fake-platform.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class FakeSandbox implements Sandbox {
  readonly id = "fake-container"
  async exec(args: string[], options?: SandboxExecOptions): Promise<CommandResult> {
    if (args[0] !== "python3") return { code: 0, stdout: "", stderr: "" }
    const payload = JSON.parse(options?.input ?? "{}") as { op?: string; path?: string }
    const missing = payload.op === "info" || payload.op === "sha256"
    return {
      code: 0,
      stdout: JSON.stringify(
        missing
          ? { ok: false, code: "not_found", message: "not found", path: payload.path }
          : { ok: true, value: payload.op === "canonical" ? payload.path : null },
      ),
      stderr: "",
    }
  }
  async close(): Promise<void> {}
}

const model: Model<"openai-completions"> = {
  id: "reasoning-model",
  name: "Reasoning model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://models.example.test/v1?token=secret",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
  maxTokens: 4_096,
}

const agent = {
  streamFn: (() => {
    throw new Error("this test does not call the model")
  }) as AgentOptions["streamFn"],
  initialState: { model, thinkingLevel: "high" },
} satisfies AgentOptions

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ctf-run-config-"))
  roots.push(root)
  await mkdir(join(root, ".pi", "skills", "reverse"), { recursive: true })
  await writeFile(
    join(root, ".pi", "ctf-config.json"),
    JSON.stringify({
      version: 1,
      project: { id: "freeze-project", name: "Freeze Project" },
      platform: { plugin: "test", config: {} },
      sandbox: { image: "test-image", privileged: false, networkMode: "none" },
    }),
  )
  await writeFile(
    join(root, ".pi", "skills", "reverse", "SKILL.md"),
    "---\nname: reverse\ndescription: Analyze binaries\n---\n# Reverse",
  )
  return root
}

async function openProject(
  root: string,
  options: Partial<Parameters<typeof Project.open>[0]> = {},
) {
  let sandboxes = 0
  const project = await Project.open({
    root,
    platforms: [testPlatform],
    sandboxFactory: async () => {
      sandboxes++
      return new FakeSandbox()
    },
    ...options,
  })
  return { project, sandboxes: () => sandboxes }
}

async function snapshotOf(root: string, runId: string): Promise<RunConfigSnapshot> {
  return JSON.parse(
    await readFile(join(root, ".ctf-agent", "runs", runId, "run-config.json"), "utf8"),
  ) as RunConfigSnapshot
}

describe("Run configuration freeze", () => {
  it("freezes settings, skills, roles, model, and runtime profile before the Run starts", async () => {
    const root = await fixture()
    const { project } = await openProject(root)
    try {
      const solver = await project.createSolver("warmup-flag", { agent })
      const snapshot = await snapshotOf(root, solver.runId)
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        runId: solver.runId,
        challengeId: "warmup-flag",
        settings: defaultRunSettings(),
        skills: { solver: ["reverse"], subagentDefault: ["reverse"], subagentRoles: {} },
        model: {
          provider: "test",
          id: "reasoning-model",
          endpoint: "https://models.example.test",
          thinkingLevel: "high",
        },
        limits: { sandboxPrivileged: false, sandboxNetworkMode: "none" },
        runtimeProfile: {
          adapterId: "pi-agent-session-v1",
          sessionFormat: "pi-session-v3",
          packages: { "@earendil-works/pi-coding-agent": "1.5.0" },
          runStoreCapabilities: { "accepted-fact": 1 },
          optimizationCapabilities: [],
        },
      })
      expect(snapshot.runtimeProfile.lockfileSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(snapshot.subagentRoles.length).toBeGreaterThan(0)
      expect(JSON.stringify(snapshot)).not.toContain("secret")

      const frozen = project
        .runEvents(solver.runId)
        .find((event) => event.type === "run_configuration_frozen")
      expect(frozen?.data).toMatchObject({
        configHash: runConfigHash(snapshot),
        path: `runs/${solver.runId}/run-config.json`,
        adapterId: "pi-agent-session-v1",
      })
      await solver.close("manual")
    } finally {
      await project.close()
    }
  })

  it("keeps the original snapshot on resume and marks Runs without one as legacy", async () => {
    const root = await fixture()
    const { project } = await openProject(root)
    try {
      const first = await project.createSolver("warmup-flag", { agent })
      const original = await snapshotOf(root, first.runId)
      await first.close("failed", "stopped for the test")
      const resumed = await project.resumeSolver(first.runId, { agent })
      expect(await snapshotOf(root, first.runId)).toEqual(original)
      expect(project.runEvents(first.runId).map((event) => event.type)).toContain(
        "run_configuration_restored",
      )
      await resumed.close("failed", "stopped again")

      await rm(join(root, ".ctf-agent", "runs", first.runId, "run-config.json"))
      const legacy = await project.resumeSolver(first.runId, { agent })
      expect(
        project
          .runEvents(first.runId)
          .find((event) => event.type === "run_configuration_legacy_resume")?.data,
      ).toEqual({ reason: "snapshot_missing" })
      await legacy.close("manual")
    } finally {
      await project.close()
    }
  })

  it("refuses to start a Run whose settings this build cannot honor, before any sandbox exists", async () => {
    const root = await fixture()
    const settings = mergeRunSettings(defaultRunSettings(), {
      optimization: { blackboardReaderV2: true },
    })
    const { project, sandboxes } = await openProject(root, { runSettings: () => settings })
    try {
      await expect(project.createSolver("warmup-flag", { agent })).rejects.toThrow(
        "blackboard-reader-v2",
      )
      expect(sandboxes()).toBe(0)
      const [run] = project.runs({ challengeId: "warmup-flag" })
      expect(run?.error).toContain("optimization.blackboardReaderV2")
    } finally {
      await project.close()
    }
  })
})

describe("run configuration snapshot", () => {
  const input = {
    runId: "run-1",
    challengeId: "c1",
    settings: defaultRunSettings(),
    skills: [{ name: "reverse", description: "d", filePath: "/s/SKILL.md", baseDir: "/s" }],
    subagentRoles: new Map(),
    model,
    thinkingLevel: "high" as const,
    sandbox: { privileged: false, networkMode: "none" },
  }

  it("hashes the configuration, not the Run identity or freeze time", async () => {
    const first = await buildRunConfigSnapshot(input)
    const second = await buildRunConfigSnapshot({ ...input, runId: "run-2", challengeId: "c2" })
    expect(runConfigHash(first)).toBe(runConfigHash(second))
    const changed = await buildRunConfigSnapshot({ ...input, thinkingLevel: "low" })
    expect(runConfigHash(changed)).not.toBe(runConfigHash(first))
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}')
  })

  it("fails on skills or roles that do not exist instead of silently dropping them", async () => {
    const withSkills = (skills: Parameters<typeof mergeRunSettings>[1]["skills"]) => ({
      ...input,
      settings: mergeRunSettings(defaultRunSettings(), { skills }),
    })
    await expect(buildRunConfigSnapshot(withSkills({ solver: ["missing"] }))).rejects.toThrow(
      "missing",
    )
    await expect(
      buildRunConfigSnapshot(withSkills({ subagents: { roles: { ghost: "all" } } })),
    ).rejects.toThrow("ghost")
  })
})
