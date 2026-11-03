import { createHash } from "node:crypto"
import { cp, readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

/**
 * Solver state that ConfigStore.resetProjectData() deletes; a sample must start
 * without any of it so runs, blackboard, sessions and workspaces never leak in.
 */
const SOLVER_STATE = /^(runs\.sqlite(-shm|-wal|-journal)?|runs|challenges)$/
/** Unrelated persistent state that would only bloat or contaminate a sample. */
const UNRELATED_STATE = /^audits\.sqlite(-shm|-wal|-journal)?$/
const PROJECT_KEY = /^[a-f0-9]{32}$/
const PROJECT_DIRECTORY = /^projects\/[a-f0-9]{32}$/
const SENSITIVE_FILES = new Set(["secrets.json", "auth.json"])

/**
 * Whether a template path (relative, "/"-separated) is configuration that a
 * sample inherits: everything under .pi and .ctf-agent except solver state.
 */
export function isConfigurationPath(rel: string): boolean {
  const parts = rel.split("/")
  if (parts[0] === ".pi") return true
  if (parts[0] !== ".ctf-agent") return false
  const [, second = "", third = "", fourth = ""] = parts
  if (parts.length === 2) return !SOLVER_STATE.test(second) && !UNRELATED_STATE.test(second)
  if (parts.length === 4 && second === "projects" && PROJECT_KEY.test(third)) {
    return !SOLVER_STATE.test(fourth)
  }
  return true
}

function relativePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/")
}

/** Configuration files a sample would inherit from the template, sorted. */
export async function listTemplateConfiguration(templateRoot: string): Promise<string[]> {
  const root = resolve(templateRoot)
  const listed: string[] = []
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (!isConfigurationPath(relativePath(root, absolute))) continue
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) listed.push(relativePath(root, absolute))
    }
  }
  await walk(root)
  return listed.sort((left, right) => left.localeCompare(right))
}

/** Content hash of the template configuration; secret files contribute presence only. */
export async function templateFingerprint(templateRoot: string): Promise<{
  sha256: string
  files: number
  sensitiveFilesPresent: string[]
}> {
  const files = await listTemplateConfiguration(templateRoot)
  const hash = createHash("sha256")
  const sensitive: string[] = []
  for (const path of files) {
    hash.update(`${path}\0`)
    if (SENSITIVE_FILES.has(path.split("/").at(-1) ?? "")) {
      sensitive.push(path)
      hash.update("present\0")
      continue
    }
    const content = await readFile(join(resolve(templateRoot), ...path.split("/")))
    hash.update(`${createHash("sha256").update(content).digest("hex")}\0`)
  }
  return { sha256: hash.digest("hex"), files: files.length, sensitiveFilesPresent: sensitive }
}

/**
 * Copy a configured data root into an empty sample root, keeping configuration
 * (registry, platform, models, secrets, plugins, .pi/skills) and dropping all
 * solver state.
 */
export async function cloneTemplateRoot(templateRoot: string, sampleRoot: string): Promise<void> {
  const template = resolve(templateRoot)
  const target = resolve(sampleRoot)
  if (!(await stat(join(template, ".ctf-agent")).catch(() => undefined))?.isDirectory()) {
    throw new Error(`模板数据根缺少 .ctf-agent：${template}`)
  }
  const existing = await readdir(target).catch(() => [])
  if (existing.length > 0) throw new Error(`样本数据根必须为空：${target}`)
  await cp(template, target, {
    recursive: true,
    errorOnExist: true,
    filter: (source) => {
      const rel = relativePath(template, resolve(source))
      return rel === "" || isConfigurationPath(rel)
    },
  })
}

interface RegistryEntry {
  id: string
  directory: string
}

/** Resolve the state directory of one Project inside a data root. */
export async function projectStateDirectory(root: string, projectId: string): Promise<string> {
  const stateDirectory = join(resolve(root), ".ctf-agent")
  const registryPath = join(stateDirectory, "project-registry.json")
  let registry: unknown
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"))
  } catch (error) {
    throw new Error(`无法读取 Project 注册表 ${registryPath}`, { cause: error })
  }
  const projects =
    typeof registry === "object" && registry !== null && "projects" in registry
      ? (registry as { projects: unknown }).projects
      : undefined
  if (!Array.isArray(projects)) throw new Error(`Project 注册表格式无效：${registryPath}`)
  const entry = projects.find(
    (candidate): candidate is RegistryEntry =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as RegistryEntry).id === projectId &&
      typeof (candidate as RegistryEntry).directory === "string",
  )
  if (!entry) throw new Error(`模板中不存在 Project：${projectId}`)
  if (entry.directory !== "." && !PROJECT_DIRECTORY.test(entry.directory)) {
    throw new Error(`Project 状态目录无效：${entry.directory}`)
  }
  return resolve(stateDirectory, entry.directory)
}
