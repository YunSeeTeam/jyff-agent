import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type AgentSkill, parseSkillPackage } from "@ctf-agent/agents"
import { canonicalJson, type RunConfigSnapshot } from "./run-config-snapshot.ts"

export interface SkillSnapshotLimits {
  maxFiles: number
  maxBytes: number
  maxDepth: number
}
export const DEFAULT_SKILL_SNAPSHOT_LIMITS: SkillSnapshotLimits = {
  maxFiles: 2048,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 32,
}

export class SkillSnapshotError extends Error {
  readonly requiresConfiguration = true
  constructor(
    readonly code: "skill_snapshot_unavailable" | "skill_snapshot_changed" | "skill_snapshot_limit",
    message: string,
  ) {
    super(message)
    this.name = "SkillSnapshotError"
  }
}

interface PackageEntry {
  name: string
  hash: string
  sourcePath: string
  hostPath: string
  containerPath: string
}
export interface RunSkillManifest {
  schemaVersion: 1
  runId: string
  origin: "new_run" | "legacy_resume"
  createdAt: string
  selections: RunConfigSnapshot["skills"]
  packages: PackageEntry[]
  manifestHash: string
}
interface FileBytes {
  path: string
  executable: boolean
  bytes: Buffer
}

function changed(message: string): SkillSnapshotError {
  return new SkillSnapshotError("skill_snapshot_changed", message)
}
function inside(root: string, path: string): string {
  const target = resolve(root, path)
  const suffix = relative(resolve(root), target)
  if (
    !suffix ||
    isAbsolute(suffix) ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    resolve(target) === resolve(root)
  ) {
    throw changed("Skill path must remain inside its owned directory")
  }
  return target
}
function validRunId(runId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw changed("Invalid Run identity")
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw changed("Skill directory cannot be a link")
}

/** Read a bounded package without following links. File paths and executable bits enter the hash. */
async function readPackage(
  directory: string,
  limits: SkillSnapshotLimits,
  onlyFile?: string,
): Promise<FileBytes[]> {
  const rootInfo = await lstat(directory)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw changed("Skill package root cannot be a link or special file")
  }
  if (onlyFile) {
    inside(directory, relative(directory, onlyFile))
    let ancestor = dirname(resolve(onlyFile))
    while (ancestor !== resolve(directory)) {
      const info = await lstat(ancestor)
      if (!info.isDirectory() || info.isSymbolicLink()) throw changed("Skill path contains a link")
      ancestor = dirname(ancestor)
    }
  }
  const files: FileBytes[] = []
  let bytes = 0
  const walk = async (path: string, name: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth)
      throw new SkillSnapshotError("skill_snapshot_limit", "Skill nesting limit")
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw changed("Skill packages cannot contain links")
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        await walk(join(path, child), name ? `${name}/${child}` : child, depth + 1)
      }
    } else {
      if (!info.isFile()) throw changed("Skill packages must contain ordinary files")
      bytes += info.size
      if (files.length >= limits.maxFiles || bytes > limits.maxBytes) {
        throw new SkillSnapshotError("skill_snapshot_limit", "Skill package file/byte limit")
      }
      const content = await readFile(path)
      if (content.length !== info.size) throw changed("Skill source changed during read")
      files.push({ path: name, executable: (info.mode & 0o111) !== 0, bytes: content })
    }
  }
  await walk(onlyFile ?? directory, onlyFile ? "SKILL.md" : "", 0)
  return files
}
function packageHash(files: FileBytes[]): string {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(JSON.stringify([file.path, file.executable, file.bytes.length]))
    hash.update(file.bytes)
  }
  return hash.digest("hex")
}
async function writePackage(directory: string, files: FileBytes[]): Promise<void> {
  for (const file of files) {
    const target = inside(directory, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.bytes, { flag: "wx" })
    if (process.platform !== "win32") await chmod(target, file.executable ? 0o755 : 0o644)
  }
}
export function skillManifestHash(manifest: Omit<RunSkillManifest, "manifestHash">): string {
  const { createdAt: _createdAt, ...stable } = manifest
  return `v1:${createHash("sha256").update(canonicalJson(stable)).digest("hex")}`
}

export interface OpenRunSkillsInput {
  runDirectory: string
  workspace: string
  configuration: RunConfigSnapshot
  discovered: readonly AgentSkill[]
  /** Once a Run has started, a missing snapshot is corruption, never permission to re-read sources. */
  hasStarted: boolean
  limits?: Partial<SkillSnapshotLimits>
  onPublished?: (manifest: RunSkillManifest) => void
  onRepaired?: (name: string) => void
}

/** Host packages are authoritative; each consumer verifies and repairs its workspace copies. */
export async function openRunSkills(input: OpenRunSkillsInput): Promise<{
  manifest: RunSkillManifest
  forSolver(): Promise<AgentSkill[]>
  forRole(role: string): Promise<AgentSkill[]>
}> {
  const { runDirectory, configuration, workspace } = input
  validRunId(configuration.runId)
  const limits = { ...DEFAULT_SKILL_SNAPSHOT_LIMITS, ...input.limits }
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid skill snapshot limits")
  }
  const published = join(runDirectory, "skills")
  let manifest: RunSkillManifest
  if (!(await exists(published))) {
    if (input.hasStarted)
      throw new SkillSnapshotError("skill_snapshot_unavailable", "Run skill snapshot is missing")
    const staging = inside(runDirectory, `.skills-staging-${randomUUID()}`)
    await mkdir(join(staging, "packages"), { recursive: true })
    try {
      const selections = structuredClone(configuration.skills)
      const wanted = [
        ...new Set([
          ...selections.solver,
          ...selections.subagentDefault,
          ...Object.values(selections.subagentRoles).flat(),
        ]),
      ].sort()
      const packages: PackageEntry[] = []
      const sources: Array<{ skill: AgentSkill; onlyFile?: string; hash: string }> = []
      let totalFiles = 0
      let totalBytes = 0
      for (const name of wanted) {
        const skill = input.discovered.find((candidate) => candidate.name === name)
        if (!skill)
          throw new SkillSnapshotError(
            "skill_snapshot_unavailable",
            `Skill source missing: ${name}`,
          )
        const onlyFile =
          basename(skill.filePath).toLowerCase() === "skill.md" ? undefined : skill.filePath
        const files = await readPackage(skill.baseDir, limits, onlyFile)
        totalFiles += files.length
        totalBytes += files.reduce((sum, file) => sum + file.bytes.length, 0)
        if (totalFiles > limits.maxFiles || totalBytes > limits.maxBytes) {
          throw new SkillSnapshotError(
            "skill_snapshot_limit",
            "Selected skills exceed Run file/byte limit",
          )
        }
        const hash = packageHash(files)
        sources.push({ skill, onlyFile, hash })
        const hostPath = `packages/${hash}`
        await writePackage(join(staging, hostPath), files)
        parseSkillPackage(join(staging, hostPath), name)
        if (hash !== packageHash(await readPackage(skill.baseDir, limits, onlyFile))) {
          throw changed(`Skill source changed during publication: ${name}`)
        }
        packages.push({
          name,
          hash,
          sourcePath: skill.filePath,
          hostPath,
          containerPath: `/workspace/.skills/${configuration.runId}/${hash}/SKILL.md`,
        })
      }
      const body = {
        schemaVersion: 1 as const,
        runId: configuration.runId,
        origin: configuration.origin,
        createdAt: new Date().toISOString(),
        selections,
        packages,
      }
      for (const source of sources) {
        if (
          source.hash !==
          packageHash(await readPackage(source.skill.baseDir, limits, source.onlyFile))
        ) {
          throw changed(`Skill source changed before publication: ${source.skill.name}`)
        }
      }
      manifest = { ...body, manifestHash: skillManifestHash(body) }
      await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), {
        flag: "wx",
      })
      await rename(staging, published)
    } finally {
      await rm(inside(runDirectory, relative(runDirectory, staging)), {
        recursive: true,
        force: true,
      })
    }
  }
  try {
    const info = await lstat(published)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw changed("Published skill directory is invalid")
    const packagesInfo = await lstat(join(published, "packages"))
    if (!packagesInfo.isDirectory() || packagesInfo.isSymbolicLink())
      throw changed("Published package root is invalid")
    const manifestPath = join(published, "manifest.json")
    const manifestInfo = await lstat(manifestPath)
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.size > 1024 * 1024
    ) {
      throw changed("Invalid skill manifest file")
    }
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RunSkillManifest
    const { manifestHash, ...body } = manifest
    if (
      manifest.schemaVersion !== 1 ||
      manifest.runId !== configuration.runId ||
      manifestHash !== skillManifestHash(body) ||
      canonicalJson(manifest.selections) !== canonicalJson(configuration.skills) ||
      !Array.isArray(manifest.packages)
    )
      throw changed("Skill manifest identity/hash does not match")
    const wanted = new Set([
      ...configuration.skills.solver,
      ...configuration.skills.subagentDefault,
      ...Object.values(configuration.skills.subagentRoles).flat(),
    ])
    if (manifest.packages.length !== wanted.size)
      throw changed("Skill package inventory does not match")
    for (const entry of manifest.packages) {
      if (
        !wanted.delete(entry.name) ||
        !/^[0-9a-f]{64}$/.test(entry.hash) ||
        entry.hostPath !== `packages/${entry.hash}` ||
        entry.containerPath !== `/workspace/.skills/${configuration.runId}/${entry.hash}/SKILL.md`
      ) {
        throw changed("Invalid skill package inventory")
      }
      if (packageHash(await readPackage(join(published, entry.hostPath), limits)) !== entry.hash) {
        throw changed(`Published skill package changed: ${entry.name}`)
      }
    }
  } catch (error) {
    if (error instanceof SkillSnapshotError) throw error
    throw new SkillSnapshotError(
      "skill_snapshot_unavailable",
      "Run skill manifest or package cannot be read",
    )
  }
  // Idempotent caller event recording also repairs the rename-before-event crash window.
  input.onPublished?.(manifest)
  let serial = Promise.resolve()
  const materialize = (names: string[]): Promise<AgentSkill[]> => {
    const operation = serial.then(async () => {
      await safeDirectory(workspace)
      await safeDirectory(join(workspace, ".skills"))
      const workspaceRoot = join(workspace, ".skills", configuration.runId)
      await safeDirectory(workspaceRoot)
      const skills: AgentSkill[] = []
      for (const path of [published, join(published, "packages")]) {
        const info = await lstat(path)
        if (!info.isDirectory() || info.isSymbolicLink())
          throw changed("Published skill directory changed")
      }
      try {
        const path = join(published, "manifest.json")
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
          throw changed("Published manifest file changed")
        }
        const current = JSON.parse(await readFile(path, "utf8")) as RunSkillManifest
        const { manifestHash, ...body } = current
        if (manifestHash !== manifest.manifestHash || manifestHash !== skillManifestHash(body)) {
          throw changed("Published manifest changed")
        }
      } catch (error) {
        if (error instanceof SkillSnapshotError) throw error
        throw new SkillSnapshotError(
          "skill_snapshot_unavailable",
          "Published manifest cannot be read",
        )
      }
      for (const name of names) {
        const entry = manifest.packages.find((candidate) => candidate.name === name)
        if (!entry) throw changed(`Skill absent from manifest: ${name}`)
        const source = join(published, entry.hostPath)
        const files = await readPackage(source, limits)
        if (packageHash(files) !== entry.hash)
          throw changed(`Published skill package changed: ${name}`)
        const target = inside(workspaceRoot, entry.hash)
        let valid = false
        try {
          valid = packageHash(await readPackage(target, limits)) === entry.hash
        } catch {
          /* repair below */
        }
        if (!valid) {
          const temporary = inside(workspaceRoot, `.repair-${randomUUID()}`)
          await writePackage(temporary, files)
          // The complete target is a direct child of the checked Run directory; rm never follows its links.
          await rm(target, { recursive: true, force: true })
          await rename(temporary, target)
          input.onRepaired?.(name)
        }
        const skill = parseSkillPackage(source, name)
        skills.push({
          ...skill,
          filePath: entry.containerPath,
          sandboxPath: entry.containerPath,
          sandboxBaseDir: dirname(entry.containerPath).replaceAll("\\", "/"),
        })
      }
      return skills
    })
    serial = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
  return {
    manifest,
    forSolver: () => materialize(manifest.selections.solver),
    forRole: (role) =>
      materialize(
        Object.hasOwn(manifest.selections.subagentRoles, role)
          ? manifest.selections.subagentRoles[role]!
          : manifest.selections.subagentDefault,
      ),
  }
}
