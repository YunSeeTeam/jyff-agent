import { lstat, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

export class DataCompatibilityError extends Error {
  readonly code = "source_update_data_incompatible"
  readonly status = 409
}

/** Read only the known state roots, including archived projects. Never follow links. */
export async function requiredDataCapabilities(dataRoot: string): Promise<Record<string, number>> {
  const state = join(dataRoot, ".ctf-agent")
  const stateStat = await lstat(state)
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) {
    throw new DataCompatibilityError("Expected the backend's real .ctf-agent state directory")
  }
  const roots = [state]
  const projects = join(state, "projects")
  try {
    if ((await lstat(projects)).isSymbolicLink()) {
      throw new DataCompatibilityError("Project state directory must not be a symbolic link")
    }
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!/^[a-f0-9]{32}$/.test(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new DataCompatibilityError("Cannot verify a linked project state directory")
      }
      roots.push(join(projects, entry.name))
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const required: Record<string, number> = Object.create(null)
  for (const root of roots) {
    const path = join(root, "runs.sqlite")
    try {
      if ((await lstat(root)).isSymbolicLink() || !(await lstat(path)).isFile()) {
        throw new DataCompatibilityError("Cannot verify linked or non-file RunStore")
      }
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_data_capabilities'",
        )
        .get()
      if (!table) continue
      for (const row of db.prepare("SELECT name, version FROM runtime_data_capabilities").all()) {
        if (
          typeof row.name !== "string" ||
          row.name.length === 0 ||
          typeof row.version !== "number" ||
          !Number.isSafeInteger(row.version) ||
          row.version < 1
        ) {
          throw new DataCompatibilityError("Invalid RunStore capability declaration")
        }
        required[row.name] = Math.max(required[row.name] ?? 0, row.version)
      }
    } finally {
      db.close()
    }
  }
  return required
}

/** Called before every switch, including automatic rollback after migrations. */
export async function assertDataCompatible(candidate: string, dataRoot?: string): Promise<void> {
  if (!dataRoot) {
    throw new DataCompatibilityError(
      "Set CTF_AGENT_UPDATE_DATA_ROOT to the backend --root before applying or rolling back",
    )
  }
  const required = await requiredDataCapabilities(dataRoot)
  let supported: Record<string, unknown> = {}
  try {
    const manifest = JSON.parse(
      await readFile(join(candidate, "runtime-data-capabilities.json"), "utf8"),
    ) as { schemaVersion?: unknown; read?: Record<string, unknown> }
    if (
      manifest.schemaVersion !== 1 ||
      !manifest.read ||
      typeof manifest.read !== "object" ||
      Array.isArray(manifest.read)
    ) {
      throw new DataCompatibilityError("Invalid candidate data capability manifest")
    }
    supported = manifest.read
    if (
      Object.entries(supported).some(
        ([name, version]) =>
          !name || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1,
      )
    ) {
      throw new DataCompatibilityError("Invalid candidate data capability version")
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const missing = Object.entries(required).filter(([name, version]) => {
    const available = supported[name]
    return typeof available !== "number" || !Number.isSafeInteger(available) || available < version
  })
  if (missing.length) {
    throw new DataCompatibilityError(
      `Candidate cannot read current data: ${missing.map(([name, version]) => `${name}@${version}`).join(", ")}. Use a compatible bounded build, or restore its matching data backup before switching.`,
    )
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
