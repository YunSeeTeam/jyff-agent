/**
 * Backend-independent filesystem and shell contract used by the container tools.
 *
 * Pi 1.x removed `ExecutionEnv` from its core package and its coding-agent tools
 * resolve paths with host rules, which breaks POSIX container paths on Windows
 * hosts. jyff therefore owns this contract; it keeps the shape of Pi 0.82's
 * interface so the tool behavior the model sees stays unchanged.
 */

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError }

export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value }
}

export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error }
}

/** Return the success value or throw the failure error. */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
  if (!result.ok) throw result.error
  return result.value
}

export type FileKind = "file" | "directory" | "symlink"

export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown"

export class FileError extends Error {
  readonly code: FileErrorCode
  /** Absolute addressed path associated with the failure, when available. */
  readonly path?: string

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "FileError"
    this.code = code
    this.path = path
  }
}

export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown"

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "ExecutionError"
    this.code = code
  }
}

export interface FileInfo {
  name: string
  path: string
  kind: FileKind
  size: number
  mtimeMs: number
}

export interface ShellExecOptions {
  cwd?: string
  env?: Record<string, string>
  inheritEnv?: boolean
  /** Timeout in seconds. */
  timeout?: number
  abortSignal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ExecutionEnv {
  readonly cwd: string
  absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>
  joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>
  readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>
  readTextLines(
    path: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>>
  readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>
  writeFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>
  appendFile(
    path: string,
    content: string | Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Result<void, FileError>>
  fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>
  listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>
  canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>
  exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>
  createDir(
    path: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>>
  remove(
    path: string,
    options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ): Promise<Result<void, FileError>>
  createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>
  createTempFile(options?: {
    prefix?: string
    suffix?: string
    abortSignal?: AbortSignal
  }): Promise<Result<string, FileError>>
  exec(command: string, options?: ShellExecOptions): Promise<Result<ShellResult, ExecutionError>>
  /** Release shell resources. Best-effort; must not throw or reject. */
  cleanup(): Promise<void>
}
