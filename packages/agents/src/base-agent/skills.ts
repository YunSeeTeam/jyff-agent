import { existsSync, statSync } from "node:fs"
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { loadSkillsFromDir, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent"

export interface AgentSkill {
  name: string
  description: string
  /** Host path of the skill file; replaced by the container path after materialization. */
  filePath: string
  baseDir: string
  content?: string
  disableModelInvocation?: boolean
  /** Container-visible paths set after materialization. */
  sandboxPath?: string
  sandboxBaseDir?: string
}

export interface DiscoveredSkills {
  skills: AgentSkill[]
  diagnostics: ResourceDiagnostic[]
}

/** Discover project skills with Pi's canonical parser and diagnostics. Earlier roots win by name. */
export async function discoverProjectSkillsWithDiagnostics(
  root: string,
  extraPaths: readonly string[] = [],
): Promise<DiscoveredSkills> {
  const directories = [
    join(root, ".pi", "skills"),
    ...extraPaths.map((path) => resolve(root, path)),
  ]
  const byName = new Map<string, AgentSkill>()
  const diagnostics: ResourceDiagnostic[] = []
  for (const dir of directories) {
    // Missing skill roots are optional, matching Pi 0.82's loader.
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const loaded = loadSkillsFromDir({ dir, source: "project" })
    diagnostics.push(...loaded.diagnostics)
    for (const skill of loaded.skills) {
      if (byName.has(skill.name)) continue
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
      })
    }
  }
  return { skills: [...byName.values()], diagnostics }
}

/** Backward-compatible shorthand for consumers that do not expose diagnostics yet. */
export async function discoverProjectSkills(
  root: string,
  extraPaths: readonly string[] = [],
): Promise<AgentSkill[]> {
  return (await discoverProjectSkillsWithDiagnostics(root, extraPaths)).skills
}

/**
 * Copy trusted host skills into the run workspace. Symlinks are rejected so a
 * mounted skill cannot escape the container-visible workspace.
 */
export async function materializeSkills(
  skills: readonly AgentSkill[],
  workspace: string,
): Promise<AgentSkill[]> {
  const root = join(workspace, ".skills")
  await mkdir(root, { recursive: true })
  const copyTree = async (source: string, target: string): Promise<void> => {
    const stat = await lstat(source)
    if (stat.isSymbolicLink()) throw new Error(`skill 包含不允许的符号链接: ${source}`)
    if (stat.isDirectory()) {
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source, {
        withFileTypes: true,
        encoding: "utf8",
      })) {
        await copyTree(join(source, entry.name), join(target, entry.name))
      }
      return
    }
    if (!stat.isFile()) throw new Error(`skill 包含不支持的文件类型: ${source}`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  const materialized: AgentSkill[] = []
  for (const [index, skill] of skills.entries()) {
    const directory = join(root, `skill-${index + 1}`)
    const isStandardDirectory = basename(skill.filePath).toLowerCase() === "skill.md"
    if (isStandardDirectory) await copyTree(skill.baseDir, directory)
    else {
      await mkdir(directory, { recursive: true })
      await copyTree(skill.filePath, join(directory, "SKILL.md"))
    }
    materialized.push({
      ...skill,
      filePath: `/workspace/.skills/skill-${index + 1}/SKILL.md`,
      sandboxBaseDir: `/workspace/.skills/skill-${index + 1}`,
      sandboxPath: `/workspace/.skills/skill-${index + 1}/SKILL.md`,
    })
  }
  return materialized
}
