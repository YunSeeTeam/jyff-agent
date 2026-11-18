/**
 * Project settings that every new Run freezes (design 7.5, 10.1, 16.1).
 *
 * All switches default off. A switch can only be turned on once its capability
 * exists in this build and its prerequisites are on; otherwise the update is
 * rejected with `configuration_dependency_error` instead of silently degrading.
 */

/** Skill choice for one agent: everything discovered, or exactly these names. */
export type SkillSelection = "all" | string[]

export interface SkillsSettings {
  version: 1
  solver: SkillSelection
  subagents: {
    default: SkillSelection
    /** Per-role overrides; an override replaces the default, never merges with it. */
    roles: Record<string, SkillSelection>
  }
}

export interface ReviewSettings {
  enabled: boolean
  /** Limits automatic reviews, never the Solver's ability to continue the goal. */
  maxPerGoal: number
  maxConcurrent: number
}

export interface OptimizationSettings {
  schemaVersion: 1
  blackboardReaderV2: boolean
  fullSubagentReports: boolean
  skillSnapshots: boolean
  /** true requests the full process contract. The named profile only reads the two pinned archives. */
  localProcesses: boolean | "fixed-attachments"
  review: ReviewSettings
}

export interface RunSettings {
  optimization: OptimizationSettings
  skills: SkillsSettings
}

/** Partial update: omitted fields keep the current value. */
export interface RunSettingsPatch {
  optimization?: Partial<Omit<OptimizationSettings, "schemaVersion" | "review">> & {
    schemaVersion?: 1
    review?: Partial<ReviewSettings>
  }
  skills?: {
    version?: 1
    solver?: SkillSelection
    subagents?: {
      default?: SkillSelection
      /** Whole-table replacement: `{}` removes every override. */
      roles?: Record<string, SkillSelection>
    }
  }
}

export const REVIEW_MAX_PER_GOAL_LIMIT = 16
export const REVIEW_MAX_CONCURRENT_LIMIT = 8

export function defaultRunSettings(): RunSettings {
  return {
    optimization: {
      schemaVersion: 1,
      blackboardReaderV2: false,
      fullSubagentReports: false,
      skillSnapshots: false,
      localProcesses: false,
      review: { enabled: false, maxPerGoal: 2, maxConcurrent: 1 },
    },
    skills: { version: 1, solver: "all", subagents: { default: "all", roles: {} } },
  }
}

/** Trim names and drop duplicates, keeping the first occurrence. */
export function normalizeSkillSelection(selection: SkillSelection): SkillSelection {
  if (selection === "all") return "all"
  const seen = new Set<string>()
  const names: string[] = []
  for (const raw of selection) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function cloneSelection(selection: SkillSelection): SkillSelection {
  return selection === "all" ? "all" : [...selection]
}

function cloneRoles(roles: Record<string, SkillSelection>): Record<string, SkillSelection> {
  return Object.fromEntries(
    Object.entries(roles).map(([role, selection]) => [role, normalizeSkillSelection(selection)]),
  )
}

/** Merge a patch field by field; arrays and the role table are replaced, never deep-merged. */
export function mergeRunSettings(current: RunSettings, patch: RunSettingsPatch): RunSettings {
  const optimization = patch.optimization
  const skills = patch.skills
  return {
    optimization: {
      schemaVersion: 1,
      blackboardReaderV2:
        optimization?.blackboardReaderV2 ?? current.optimization.blackboardReaderV2,
      fullSubagentReports:
        optimization?.fullSubagentReports ?? current.optimization.fullSubagentReports,
      skillSnapshots: optimization?.skillSnapshots ?? current.optimization.skillSnapshots,
      localProcesses: optimization?.localProcesses ?? current.optimization.localProcesses,
      review: {
        enabled: optimization?.review?.enabled ?? current.optimization.review.enabled,
        maxPerGoal: optimization?.review?.maxPerGoal ?? current.optimization.review.maxPerGoal,
        maxConcurrent:
          optimization?.review?.maxConcurrent ?? current.optimization.review.maxConcurrent,
      },
    },
    skills: {
      version: 1,
      solver: normalizeSkillSelection(skills?.solver ?? cloneSelection(current.skills.solver)),
      subagents: {
        default: normalizeSkillSelection(
          skills?.subagents?.default ?? cloneSelection(current.skills.subagents.default),
        ),
        roles: cloneRoles(skills?.subagents?.roles ?? current.skills.subagents.roles),
      },
    },
  }
}

/**
 * Read compatibility only: discard the withdrawn budget placeholder and rename
 * the review count. Never mutate historical snapshots or use this for API input.
 * The caller still validates stored configuration after migration.
 */
export function migrateStoredRunSettings(value: unknown): unknown {
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
  if (!isRecord(value)) return value
  const { budgetPolicy: _withdrawn, ...settings } = value
  const optimization = settings.optimization
  if (isRecord(optimization) && isRecord(optimization.review)) {
    const { maxPerBudget: legacyCount, ...review } = optimization.review
    if (review.maxPerGoal === undefined && legacyCount !== undefined) {
      review.maxPerGoal = legacyCount
    }
    settings.optimization = { ...optimization, review }
  }
  return settings
}

/** The selection that applies to one SubAgent role: its override, else the SubAgent default. */
export function skillSelectionForRole(skills: SkillsSettings, role: string): SkillSelection {
  return skills.subagents.roles[role] ?? skills.subagents.default
}

/** Whether every agent keeps today's behavior of seeing all discovered skills. */
export function usesDefaultSkillSelection(skills: SkillsSettings): boolean {
  return (
    skills.solver === "all" &&
    skills.subagents.default === "all" &&
    Object.values(skills.subagents.roles).every((selection) => selection === "all")
  )
}

/** Expand a selection against the discovered skill names; unknown names are reported, not dropped. */
export function resolveSkillSelection(
  selection: SkillSelection,
  available: readonly string[],
): { names: string[]; unknown: string[] } {
  if (selection === "all") return { names: [...available], unknown: [] }
  const known = new Set(available)
  const names = normalizeSkillSelection(selection) as string[]
  return {
    names: names.filter((name) => known.has(name)),
    unknown: names.filter((name) => !known.has(name)),
  }
}

/** Capabilities a build can provide; later stages add theirs as they ship. */
export type OptimizationCapability =
  | "blackboard-reader-v2"
  | "full-subagent-reports"
  | "skill-snapshots"
  | "local-processes"
  | "fixed-attachment-reads"
  | "review"

export interface ConfigurationDependencyIssue {
  /** Dotted settings path, e.g. `optimization.localProcesses`. */
  setting: string
  /** The capability or setting that must be available first. */
  requires: string
  message: string
}

/**
 * Settings that cannot take effect in this build or with the other settings.
 * An empty list means the settings are valid as a whole.
 */
export function configurationDependencyIssues(
  settings: RunSettings,
  available: ReadonlySet<OptimizationCapability>,
): ConfigurationDependencyIssue[] {
  const issues: ConfigurationDependencyIssue[] = []
  const capability = (setting: string, name: OptimizationCapability) => {
    if (!available.has(name)) {
      issues.push({
        setting,
        requires: name,
        message: `${setting} requires the ${name} capability, which this build does not provide`,
      })
    }
  }
  const prerequisite = (setting: string, required: string, enabled: boolean) => {
    if (!enabled) {
      issues.push({ setting, requires: required, message: `${setting} requires ${required}` })
    }
  }
  const { optimization, skills } = settings
  if (optimization.blackboardReaderV2) {
    capability("optimization.blackboardReaderV2", "blackboard-reader-v2")
  }
  if (optimization.fullSubagentReports) {
    capability("optimization.fullSubagentReports", "full-subagent-reports")
  }
  if (optimization.skillSnapshots) capability("optimization.skillSnapshots", "skill-snapshots")
  if (optimization.localProcesses) {
    capability(
      "optimization.localProcesses",
      optimization.localProcesses === "fixed-attachments"
        ? "fixed-attachment-reads"
        : "local-processes",
    )
  }
  if (optimization.review.enabled) {
    capability("optimization.review.enabled", "review")
    prerequisite(
      "optimization.review.enabled",
      "optimization.blackboardReaderV2",
      optimization.blackboardReaderV2,
    )
    prerequisite(
      "optimization.review.enabled",
      "optimization.fullSubagentReports",
      optimization.fullSubagentReports,
    )
  }
  if (!usesDefaultSkillSelection(skills)) {
    prerequisite("skills", "optimization.skillSnapshots", optimization.skillSnapshots)
  }
  return issues
}
