import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CtfSubagent } from "@ctf-agent/agents"
import { SOLVER_SYSTEM_PROMPT } from "@ctf-agent/prompts"
import type { CommandResult, Sandbox, SandboxExecOptions } from "@ctf-agent/sandbox"
import type { AgentOptions } from "@earendil-works/pi-agent-core"
import type { Model } from "@earendil-works/pi-ai"
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { defaultRunSettings, mergeRunSettings } from "../../src/contracts/index.ts"
import { Project } from "../../src/project/project.ts"
import { RunStore } from "../../src/persistence/run-store.ts"
import {
  buildRunConfigSnapshot,
  canonicalJson,
  type RunConfigSnapshot,
  runConfigHash,
} from "../../src/project/run-config-snapshot.ts"
import { testPlatform } from "../fake-platform.ts"

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
        origin: "new_run",
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
          optimizationCapabilities: [
            "blackboard-reader-v2",
            "full-subagent-reports",
            "skill-snapshots",
          ],
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

  it("keeps the original snapshot on resume", async () => {
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
      await resumed.close("manual")
    } finally {
      await project.close()
    }
  })

  it("resumes a Run that started before snapshots existed with every switch off", async () => {
    const root = await fixture()
    let settings = defaultRunSettings()
    const { project } = await openProject(root, { runSettings: () => settings })
    try {
      const first = await project.createSolver("warmup-flag", { agent })
      await first.close("failed", "stopped for the test")
      // A Run from before stage 2 has run, but has no snapshot. Today's settings
      // would not even pass the dependency check; the legacy Run must not see them.
      await rm(join(root, ".ctf-agent", "runs", first.runId, "run-config.json"))
      settings = mergeRunSettings(defaultRunSettings(), {
        optimization: { blackboardReaderV2: true },
      })

      const legacy = await project.resumeSolver(first.runId, { agent })
      const snapshot = await snapshotOf(root, first.runId)
      expect(snapshot).toMatchObject({ origin: "legacy_resume", settings: defaultRunSettings() })
      expect(snapshot.runtimeProfile.sessionFormat).toBe("pi-session-v3")
      expect(
        project
          .runEvents(first.runId)
          .find((event) => event.type === "run_configuration_legacy_resume")?.data,
      ).toMatchObject({ reason: "snapshot_missing", configHash: runConfigHash(snapshot) })
      await legacy.close("failed", "stopped again")

      // From now on the legacy Run has a snapshot like any other.
      const again = await project.resumeSolver(first.runId, { agent })
      expect(await snapshotOf(root, first.runId)).toEqual(snapshot)
      const types = project.runEvents(first.runId).map((event) => event.type)
      expect(types.filter((type) => type === "run_configuration_legacy_resume")).toHaveLength(1)
      expect(types.lastIndexOf("run_configuration_restored")).toBeGreaterThan(
        types.indexOf("run_configuration_legacy_resume"),
      )
      await again.close("manual")
    } finally {
      await project.close()
    }
  })

  it("refuses a Run this build cannot honor without blocking the challenge, and freezes it once fixed", async () => {
    const root = await fixture()
    let settings = mergeRunSettings(defaultRunSettings(), {
      budgetPolicy: { enabled: true },
    })
    const { project, sandboxes } = await openProject(root, { runSettings: () => settings })
    try {
      await expect(project.createSolver("warmup-flag", { agent })).rejects.toMatchObject({
        message: expect.stringContaining("budget-policy"),
        blocked: false,
        retryable: false,
        requiresConfiguration: true,
      })
      expect(sandboxes()).toBe(0)
      const [run] = project.runs({ challengeId: "warmup-flag" })
      expect(run).toMatchObject({ status: "failed", closeReason: "failed" })
      expect(run?.error).toContain("budgetPolicy.enabled")
      expect(project.isChallengeBlocked("warmup-flag")).toBe(false)
      if (!run) throw new Error("the rejected Run was not recorded")

      // The Run never started, so resuming it is checked like a new Run.
      await expect(project.resumeSolver(run.id, { agent })).rejects.toMatchObject({
        requiresConfiguration: true,
      })

      settings = defaultRunSettings()
      const solver = await project.resumeSolver(run.id, { agent })
      expect(await snapshotOf(root, run.id)).toMatchObject({
        origin: "new_run",
        settings: defaultRunSettings(),
      })
      const types = project.runEvents(run.id).map((event) => event.type)
      expect(types).toContain("run_configuration_frozen")
      expect(types).not.toContain("run_configuration_legacy_resume")
      await solver.close("manual")
    } finally {
      await project.close()
    }
  })

  it("combines frozen skills, reader v2 and execution reports across child and Run resume", async () => {
    const root = await fixture()
    let settings = mergeRunSettings(defaultRunSettings(), {
      optimization: { blackboardReaderV2: true, fullSubagentReports: true, skillSnapshots: true },
      skills: { solver: [], subagents: { default: ["reverse"], roles: { explorer: [] } } },
    })
    const { project } = await openProject(root, { runSettings: () => settings })
    const faux = createFauxCore({ provider: "frozen-stage3" })
    const report = "verified observation ".repeat(600)
    faux.setResponses([
      fauxAssistantMessage(report),
      fauxAssistantMessage(report),
      fauxAssistantMessage(report),
    ])
    const childCreate = vi.spyOn(CtfSubagent, "create")
    const options = {
      agent: {
        streamFn: faux.streamSimple as AgentOptions["streamFn"],
        initialState: { model: faux.getModel(), thinkingLevel: "off" as const },
      },
    }
    try {
      const solver = await project.createSolver("warmup-flag", options)
      expect(solver.state.systemPrompt).toContain(SOLVER_SYSTEM_PROMPT)
      expect(solver.state.systemPrompt).not.toContain("<name>reverse</name>")
      const read = solver.tools.find((tool) => tool.name === "blackboard_read")!
      const firstIndex = await read.execute("read", {})
      expect(firstIndex.details).toMatchObject({ schemaVersion: 2 })
      const launch = solver.tools.find((tool) => tool.name === "Agent")!
      await launch.execute("launch", {
        subagent_type: "general-purpose",
        prompt: "verify",
        description: "verify",
        run_in_background: false,
      })
      const first = project.subagents(solver.runId)[0]!
      expect(first.result).toBe(report)
      expect(first.executionId).toBeTruthy()
      expect(childCreate.mock.calls[0]![0].skills?.map((skill) => skill.name)).toEqual(["reverse"])
      expect(childCreate.mock.calls[0]![0].blackboardReadTool?.name).toBe("blackboard_read")
      const skillPath = childCreate.mock.calls[0]![0].skills![0]!.sandboxPath!
      const copy = join(solver.workspace, skillPath.slice("/workspace/".length))
      await writeFile(copy, "modified by worker")
      await writeFile(join(root, ".pi/skills/reverse/SKILL.md"), "changed source")
      settings = defaultRunSettings()
      await launch.execute("resume-child", {
        subagent_type: "general-purpose",
        prompt: "verify again",
        description: "verify",
        resume: first.id,
      })
      const second = project.subagents(solver.runId)[0]!
      expect(second.executionId).not.toBe(first.executionId)
      expect(second.result).toBe(report)
      expect(await readFile(copy, "utf8")).toContain("# Reverse")
      expect(
        project.runEvents(solver.runId).filter((event) => event.type === "run_skill_snapshot"),
      ).toHaveLength(1)
      await solver.close("failed", "test recovery")
      const resumed = await project.resumeSolver(solver.runId, options)
      expect(
        (await resumed.tools.find((tool) => tool.name === "blackboard_read")!.execute("read", {}))
          .details,
      ).toMatchObject({ schemaVersion: 2 })
      await resumed.tools
        .find((tool) => tool.name === "Agent")!
        .execute("explorer", { subagent_type: "explorer", prompt: "verify", description: "verify" })
      expect(childCreate.mock.calls.at(-1)![0].skills).toEqual([])
      await resumed.prepareWriteup()
      expect(resumed.activeTools.map((tool) => tool.name).sort()).toEqual([
        "edit",
        "list",
        "read",
        "write",
      ])
      await resumed.close("manual")
    } finally {
      await project.close()
    }
  })

  it("rejects a reader configuration whose enabled custom role excludes blackboard_read", async () => {
    const root = await fixture()
    await mkdir(join(root, ".agents/agents"), { recursive: true })
    await writeFile(
      join(root, ".agents/agents/restricted.md"),
      "---\ndescription: Restricted\ntools: [read]\n---\nInspect input",
    )
    const { project, sandboxes } = await openProject(root, {
      runSettings: () =>
        mergeRunSettings(defaultRunSettings(), { optimization: { blackboardReaderV2: true } }),
    })
    try {
      await expect(project.createSolver("warmup-flag", { agent })).rejects.toMatchObject({
        requiresConfiguration: true,
        message: expect.stringContaining("blackboard_read"),
      })
      expect(sandboxes()).toBe(0)
      expect(project.isChallengeBlocked("warmup-flag")).toBe(false)
    } finally {
      await project.close()
    }
  })

  it("exposes a failed report commit through the Project report reader instead of perpetual pending", async () => {
    const root = await fixture()
    const { project } = await openProject(root, {
      runSettings: () =>
        mergeRunSettings(defaultRunSettings(), { optimization: { fullSubagentReports: true } }),
    })
    const faux = createFauxCore({ provider: "report-commit-fault" })
    faux.setResponses([fauxAssistantMessage("captured report")])
    const commit = vi.spyOn(RunStore.prototype, "commitSubagentResult").mockImplementation(() => {
      throw new Error("disk unavailable")
    })
    try {
      const solver = await project.createSolver("warmup-flag", {
        agent: {
          streamFn: faux.streamSimple as AgentOptions["streamFn"],
          initialState: { model: faux.getModel(), thinkingLevel: "off" },
        },
      })
      const result = await solver.tools
        .find((tool) => tool.name === "Agent")!
        .execute("launch", {
          subagent_type: "general-purpose",
          prompt: "verify",
          description: "verify",
        })
      expect(result.isError).toBe(true)
      const record = project.subagents(solver.runId)[0]!
      expect(record.status).not.toBe("completed")
      expect(project.subagentResult(solver.runId, { agentId: record.id })).toMatchObject({
        error: { code: "report_persistence_failed" },
      })
      commit.mockRestore()
      await solver.close("manual")
    } finally {
      commit.mockRestore()
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
