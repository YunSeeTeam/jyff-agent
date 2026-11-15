import { describe, expect, it } from "vite-plus/test"
import {
  configurationDependencyIssues,
  defaultRunSettings,
  mergeRunSettings,
  type OptimizationCapability,
  resolveSkillSelection,
  skillSelectionForRole,
  usesDefaultSkillSelection,
} from "../../src/contracts/index.ts"

const none = new Set<OptimizationCapability>()

describe("run settings merge", () => {
  it("keeps every current value when the patch omits it", () => {
    const current = mergeRunSettings(defaultRunSettings(), {
      optimization: { review: { maxPerGoal: 5 } },
      skills: { solver: ["reverse"], subagents: { roles: { web: ["recon"] } } },
    })
    expect(mergeRunSettings(current, {})).toEqual(current)
    expect(mergeRunSettings(current, { optimization: {} })).toEqual(current)
  })

  it("merges declared object fields and replaces arrays and the role table", () => {
    const current = mergeRunSettings(defaultRunSettings(), {
      optimization: { review: { maxPerGoal: 5, maxConcurrent: 2 } },
      skills: { solver: ["a", "b"], subagents: { roles: { web: ["x"], pwn: ["y"] } } },
    })
    const next = mergeRunSettings(current, {
      optimization: { review: { maxConcurrent: 3 } },
      skills: { solver: ["c"], subagents: { roles: { crypto: "all" } } },
    })
    expect(next.optimization.review).toEqual({ enabled: false, maxPerGoal: 5, maxConcurrent: 3 })
    expect(next.skills.solver).toEqual(["c"])
    expect(next.skills.subagents.roles).toEqual({ crypto: "all" })
  })

  it("clears overrides with an empty role table and deduplicates names", () => {
    const current = mergeRunSettings(defaultRunSettings(), {
      skills: { subagents: { roles: { web: ["x"] } } },
    })
    const next = mergeRunSettings(current, {
      skills: { solver: [" a ", "b", "a", ""], subagents: { roles: {} } },
    })
    expect(next.skills.solver).toEqual(["a", "b"])
    expect(next.skills.subagents.roles).toEqual({})
  })

  it("resolves per-role selections and expands all against discovered skills", () => {
    const settings = mergeRunSettings(defaultRunSettings(), {
      skills: { subagents: { default: ["recon"], roles: { pwn: ["rop"] } } },
    })
    expect(skillSelectionForRole(settings.skills, "pwn")).toEqual(["rop"])
    expect(skillSelectionForRole(settings.skills, "web")).toEqual(["recon"])
    expect(resolveSkillSelection("all", ["a", "b"])).toEqual({ names: ["a", "b"], unknown: [] })
    expect(resolveSkillSelection(["b", "missing"], ["a", "b"])).toEqual({
      names: ["b"],
      unknown: ["missing"],
    })
    expect(usesDefaultSkillSelection(defaultRunSettings().skills)).toBe(true)
    expect(usesDefaultSkillSelection(settings.skills)).toBe(false)
  })
})

describe("configuration dependencies", () => {
  it("accepts the defaults in a build without any optional capability", () => {
    expect(configurationDependencyIssues(defaultRunSettings(), none)).toEqual([])
  })

  it("rejects a switch whose capability this build lacks", () => {
    const settings = mergeRunSettings(defaultRunSettings(), {
      optimization: { blackboardReaderV2: true },
    })
    expect(configurationDependencyIssues(settings, none)).toEqual([
      expect.objectContaining({
        setting: "optimization.blackboardReaderV2",
        requires: "blackboard-reader-v2",
      }),
    ])
    expect(
      configurationDependencyIssues(settings, new Set(["blackboard-reader-v2"] as const)),
    ).toEqual([])
  })

  it("requires snapshots for a non-default skill selection", () => {
    const settings = mergeRunSettings(defaultRunSettings(), { skills: { solver: ["reverse"] } })
    expect(configurationDependencyIssues(settings, new Set(["skill-snapshots"] as const))).toEqual([
      expect.objectContaining({ setting: "skills", requires: "optimization.skillSnapshots" }),
    ])
    const withSnapshots = mergeRunSettings(settings, { optimization: { skillSnapshots: true } })
    expect(
      configurationDependencyIssues(withSnapshots, new Set(["skill-snapshots"] as const)),
    ).toEqual([])
  })

  it("requires information contracts for review, with no budget dependency", () => {
    const all = new Set<OptimizationCapability>([
      "blackboard-reader-v2",
      "full-subagent-reports",
      "local-processes",
      "review",
    ])
    const processes = mergeRunSettings(defaultRunSettings(), {
      optimization: { localProcesses: true },
    })
    expect(configurationDependencyIssues(processes, all)).toEqual([])
    const review = mergeRunSettings(defaultRunSettings(), {
      optimization: { review: { enabled: true } },
    })
    expect(configurationDependencyIssues(review, all).map((issue) => issue.requires)).toEqual([
      "optimization.blackboardReaderV2",
      "optimization.fullSubagentReports",
    ])
    const ready = mergeRunSettings(review, {
      optimization: { blackboardReaderV2: true, fullSubagentReports: true },
    })
    expect(configurationDependencyIssues(ready, all)).toEqual([])
  })
})
