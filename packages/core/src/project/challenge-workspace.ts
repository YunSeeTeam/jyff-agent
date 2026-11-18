import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path"
import {
  EvidenceError,
  readArtifactRange,
  type ArtifactRangeQuery,
} from "./artifact-range-reader.ts"

export interface WorkspaceArtifactEntry {
  path: string
  size: number
  modifiedAt: string
}

export interface WorkspaceArtifactListing {
  files: WorkspaceArtifactEntry[]
  truncated: boolean
}

const DEFAULT_MAX_WORKSPACE_FILES = 2_000

export function challengeWorkspaceKey(challengeId: string): string {
  return createHash("sha256").update(challengeId, "utf8").digest("hex").slice(0, 32)
}

export function challengeWorkspacePath(agentDirectory: string, challengeId: string): string {
  return resolve(agentDirectory, "challenges", challengeWorkspaceKey(challengeId), "workspace")
}

export async function openChallengeWorkspaceArtifact(
  stateRoot: string,
  challengeId: string,
  path: string,
) {
  const workspace = challengeWorkspacePath(stateRoot, challengeId)
  try {
    for (const parent of [dirname(dirname(workspace)), dirname(workspace)]) {
      if (!(await lstat(parent)).isDirectory()) throw new Error("Invalid workspace parent")
    }
    return await openWorkspaceArtifact(workspace, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") throw new EvidenceError("artifact_not_found", "工作区文件不存在")
    if (code && !["ELOOP", "ENOTDIR", "EISDIR", "EINVAL"].includes(code))
      throw new EvidenceError("evidence_unavailable", "无法读取工作区文件")
    throw new EvidenceError("invalid_query", "需要工作区内的普通文件")
  }
}

export async function readChallengeWorkspaceRange(
  stateRoot: string,
  challengeId: string,
  path: string,
  query: ArtifactRangeQuery,
) {
  const handle = await openChallengeWorkspaceArtifact(stateRoot, challengeId, path)
  try {
    const before = await handle.stat({ bigint: true })
    const page = await readArtifactRange(handle, Number(before.size), query)
    const after = await handle.stat({ bigint: true })
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new EvidenceError("artifact_changed", "文件在读取期间发生变化")
    return page
  } finally {
    await handle.close()
  }
}

export function resolveWorkspaceArtifact(workspace: string, untrustedPath: string): string {
  if (
    !untrustedPath ||
    isAbsolute(untrustedPath) ||
    win32.isAbsolute(untrustedPath) ||
    /^[a-z]:/i.test(untrustedPath) ||
    untrustedPath.includes("\0")
  ) {
    throw new Error("Workspace artifact path must be a non-empty relative path")
  }
  if (
    process.platform === "win32" &&
    untrustedPath
      .split(/[\\/]/)
      .some(
        (part) =>
          part.includes(":") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("Workspace artifact path contains a reserved name")
  const root = resolve(workspace)
  const target = resolve(root, untrustedPath)
  const relation = relative(root, target)
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("Workspace artifact path escapes the challenge workspace")
  }
  return target
}

/** Reject an existing symlink whose real target leaves the challenge workspace. */
export async function assertWorkspaceArtifactContained(
  workspace: string,
  artifactPath: string,
): Promise<void> {
  const root = await realpath(workspace)
  const target = await realpath(artifactPath)
  assertRealPathContained(root, target)
}

export async function listWorkspaceArtifacts(
  workspace: string,
  maximumFiles = DEFAULT_MAX_WORKSPACE_FILES,
): Promise<WorkspaceArtifactListing> {
  let root: string
  try {
    root = await realpath(workspace)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files: [], truncated: false }
    }
    throw error
  }
  const files: WorkspaceArtifactEntry[] = []
  let truncated = false

  const visit = async (directory: string): Promise<void> => {
    const resolvedDirectory = await realpath(directory)
    assertRealPathContained(root, resolvedDirectory)
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= maximumFiles) {
        truncated = true
        return
      }
      if (entry.isSymbolicLink()) continue
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
        if (truncated) return
        continue
      }
      if (!entry.isFile()) continue
      const metadata = await lstat(absolutePath)
      files.push({
        path: relative(root, absolutePath).split(sep).join("/"),
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      })
    }
  }

  await visit(root)
  return { files, truncated }
}

/** Bind containment and regular-file checks to the descriptor that will actually be read. */
export async function openWorkspaceArtifact(
  workspace: string,
  untrustedPath: string,
): Promise<FileHandle> {
  const path = resolveWorkspaceArtifact(workspace, untrustedPath)
  if (!(await lstat(workspace)).isDirectory())
    throw new Error("Workspace artifact root must be a directory")
  const root = await realpath(workspace)
  const target = await realpath(path)
  assertRealPathContained(root, target)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile()) throw new Error("Workspace artifact is not a file")
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const opened = await handle.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (
      !opened.isFile() ||
      !current.isFile() ||
      opened.nlink !== 1n ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      (await realpath(path)) !== target ||
      (await realpath(workspace)) !== root
    )
      throw new Error("Workspace artifact changed during open or has multiple links")
    if (process.platform === "linux")
      assertRealPathContained(root, await realpath(`/proc/self/fd/${handle.fd}`))
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function readWorkspaceArtifact(
  workspace: string,
  untrustedPath: string,
  maximumBytes?: number,
): Promise<Uint8Array> {
  const handle = await openWorkspaceArtifact(workspace, untrustedPath)
  try {
    if (maximumBytes === undefined) return await handle.readFile()
    const size = (await handle.stat()).size
    if (size > maximumBytes) throw new Error(`Workspace artifact exceeds ${maximumBytes} bytes`)
    // A concurrent append cannot turn a bounded preview into a full-file read.
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if ((await handle.stat()).size > maximumBytes)
      throw new Error(`Workspace artifact exceeds ${maximumBytes} bytes`)
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

function assertRealPathContained(root: string, target: string): void {
  const relation = relative(root, target)
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("Workspace artifact symlink escapes the challenge workspace")
  }
}
