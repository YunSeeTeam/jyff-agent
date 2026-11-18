import { randomUUID } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { RunStore } from "../persistence/run-store.ts"
import {
  EvidenceError,
  hashFilePrefix,
  readArtifactRange,
  type ArtifactRangeQuery,
} from "./artifact-range-reader.ts"
import { openChallengeWorkspaceArtifact, openWorkspaceArtifact } from "./challenge-workspace.ts"

export interface ArtifactRef {
  version: 1
  refId: string
  runId: string
  /** Path at capture time, relative to the challenge workspace. */
  path: string
  byteLength: number
  state: "final" | "growing-prefix"
  sha256: string
}

export interface CaptureArtifact {
  path: string
  /** When supplied, freeze exactly this many bytes and allow the source to grow. */
  prefixBytes?: number
  expectedSha256?: string
}

/** Describes an observed experiment. Registration has no command or execution side effect. */
export interface RegisterExperiment {
  inputRefs?: string[]
  scriptRef?: string
  stdoutRef?: string
  stderrRef?: string
  status: "unknown" | "exited" | "interrupted" | "failed"
  exitCode?: number
  note?: string
}

export interface ExperimentRecord {
  version: 1
  id: string
  runId: string
  recordedAt: string
  recordedBy: "operator"
  executionId: string | null
  processSessionId: string | null
  imageDigest: string
  instanceId: string
  status: RegisterExperiment["status"]
  exitCode: number | null
  inputs: ArtifactRef[]
  script: ArtifactRef | null
  stdoutRef: string | null
  stderrRef: string | null
  note?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[a-f0-9]{64}$/
const statuses = ["unknown", "exited", "interrupted", "failed"]
const MAX_METADATA = 64 * 1024
/** Frozen copies and their sidecars have a separate, per-Run retention allowance. */
export const DEFAULT_ARTIFACT_RETAINED_BYTES = 256 * 1024 * 1024
const changed = () =>
  new EvidenceError("artifact_changed", "The saved evidence no longer matches its registration")
const notFound = () => new EvidenceError("artifact_not_found", "Evidence was not found in this Run")
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join("/")

function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 1024 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  )
}

async function directory(path: string, create = false) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  if (!(await lstat(path)).isDirectory()) throw changed()
  return path
}

async function entries(path: string) {
  try {
    await directory(path)
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

async function writeJson(path: string, value: unknown) {
  const target = await open(path, "wx", 0o600)
  try {
    await target.writeFile(JSON.stringify(value))
    await target.sync()
  } finally {
    await target.close()
  }
}

async function readJson(root: string, path: string): Promise<unknown> {
  const file = await openWorkspaceArtifact(root, path)
  try {
    const { size } = await file.stat()
    if (size > MAX_METADATA) throw changed()
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, offset, size - offset, offset)
      if (!bytesRead) throw changed()
      offset += bytesRead
    }
    return JSON.parse(buffer.toString("utf8"))
  } finally {
    await file.close()
  }
}

function isRef(raw: unknown, runId: string, refId: string): raw is ArtifactRef {
  if (!raw || typeof raw !== "object") return false
  const r = raw as Partial<ArtifactRef>
  return (
    Object.keys(r).every((key) =>
      ["version", "refId", "runId", "path", "byteLength", "state", "sha256"].includes(key),
    ) &&
    r.version === 1 &&
    r.runId === runId &&
    r.refId === refId &&
    validPath(r.path) &&
    (r.state === "final" || r.state === "growing-prefix") &&
    Number.isSafeInteger(r.byteLength) &&
    r.byteLength! >= 0 &&
    typeof r.sha256 === "string" &&
    SHA256.test(r.sha256)
  )
}

async function retainedBytes(root: string) {
  let total = 0
  for (const entry of await entries(root)) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) throw changed()
    const path = join(root, entry.name)
    for (const name of ["content.bin", "reference.json"]) {
      const file = await lstat(join(path, name))
      if (!file.isFile()) throw changed()
      total += file.size
    }
  }
  return total
}

export class RunEvidence {
  private writes: Promise<void> = Promise.resolve()
  private readonly verified = new Map<string, string>()
  private readonly registrations = new Map<string, string>()
  private closed = false

  constructor(
    private readonly stateRoot: string,
    private readonly runs: RunStore,
    private readonly retainedLimit = DEFAULT_ARTIFACT_RETAINED_BYTES,
  ) {}

  /** The Project owns the writer. Serialize reservations, publication and Run deletion. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new EvidenceError("evidence_unavailable", "Project is closing"))
    const result = this.writes.then(operation)
    this.writes = result.then(
      () => {},
      () => {},
    )
    return result
  }

  async close() {
    this.closed = true
    await this.writes
    this.verified.clear()
    this.registrations.clear()
  }

  forget(runId: string) {
    for (const key of this.registrations.keys()) {
      if (key.startsWith(runId + "/")) {
        this.registrations.delete(key)
        this.verified.delete(key)
      }
    }
  }

  private async location(runId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw notFound()
    const run = this.runs.getRun(runId)
    if (!run) throw notFound()
    const runsRoot = await directory(join(this.stateRoot, "runs"))
    return { root: await directory(join(runsRoot, runId)), run }
  }

  capture(runId: string, input: CaptureArtifact): Promise<ArtifactRef> {
    return this.exclusive(async () => {
      if (
        !validPath(input.path) ||
        (input.expectedSha256 !== undefined && !SHA256.test(input.expectedSha256)) ||
        (input.prefixBytes !== undefined &&
          (!Number.isSafeInteger(input.prefixBytes) || input.prefixBytes < 0))
      )
        throw new EvidenceError("invalid_query", "Invalid workspace path, prefix length or SHA-256")
      const { root, run } = await this.location(runId)
      const openSource = () =>
        openChallengeWorkspaceArtifact(this.stateRoot, run.challengeId, input.path)
      const source = await openSource()
      try {
        const before = await source.stat({ bigint: true })
        const length = input.prefixBytes ?? Number(before.size)
        if (!Number.isSafeInteger(length) || BigInt(length) > before.size)
          throw new EvidenceError("invalid_offset", "Requested prefix exceeds the current file")
        const dir = await directory(join(root, "artifacts"), true)
        const ref: ArtifactRef = {
          version: 1,
          runId,
          refId: randomUUID(),
          path: input.path,
          byteLength: length,
          state: input.prefixBytes === undefined ? "final" : "growing-prefix",
          sha256: "0".repeat(64),
        }
        if (
          (await retainedBytes(dir)) + length + Buffer.byteLength(JSON.stringify(ref)) >
          this.retainedLimit
        )
          throw new EvidenceError(
            "artifact_storage_limit",
            "This Run has insufficient space for another frozen copy",
          )
        const stage = join(dir, `.pending-${ref.refId}`)
        await mkdir(stage, { mode: 0o700 })
        try {
          const copy = await open(join(stage, "content.bin"), "wx+", 0o600)
          try {
            ref.sha256 = await hashFilePrefix(source, length, copy)
            await copy.sync()
            if (
              (input.expectedSha256 && ref.sha256 !== input.expectedSha256) ||
              ref.sha256 !== (await hashFilePrefix(copy, length))
            )
              throw changed()
          } finally {
            await copy.close()
          }
          // An append is OK for a prefix, but replacing the path or rewriting
          // bytes already copied cannot publish a different source silently.
          const check = await openSource().catch(() => {
            throw changed()
          })
          try {
            const current = await check.stat({ bigint: true })
            if (
              current.dev !== before.dev ||
              current.ino !== before.ino ||
              (ref.state === "final" && stamp(current) !== stamp(before)) ||
              ref.sha256 !== (await hashFilePrefix(check, length)) ||
              (ref.state === "final" && stamp(await check.stat({ bigint: true })) !== stamp(before))
            )
              throw changed()
          } finally {
            await check.close()
          }
          await writeJson(join(stage, "reference.json"), ref)
          this.runs.requireDataCapability("frozen-artifacts")
          await rename(stage, join(dir, ref.refId))
        } finally {
          await rm(stage, { recursive: true, force: true })
        }
        this.register(ref)
        const saved = await lstat(join(dir, ref.refId, "content.bin"), { bigint: true })
        this.verified.set(runId + "/" + ref.refId, ref.sha256 + "/" + stamp(saved))
        return ref
      } finally {
        await source.close()
      }
    })
  }

  private register(ref: ArtifactRef) {
    const { refId, path, state, byteLength, sha256 } = ref
    this.runs.appendEvent(ref.runId, "artifact_registered", {
      refId,
      path,
      state,
      byteLength,
      sha256,
    })
    this.registrations.set(
      ref.runId + "/" + refId,
      JSON.stringify([path, state, byteLength, sha256]),
    )
  }

  private async reference(root: string, runId: string, id: string): Promise<ArtifactRef> {
    if (!UUID.test(id)) throw notFound()
    try {
      await directory(join(root, "artifacts"))
      await directory(join(root, "artifacts", id))
    } catch (error) {
      if (missing(error)) throw this.registrations.has(runId + "/" + id) ? changed() : notFound()
      throw error
    }
    try {
      const raw = await readJson(root, `artifacts/${id}/reference.json`)
      if (!isRef(raw, runId, id)) throw changed()
      const registered = this.registrations.get(runId + "/" + id)
      if (
        registered !== undefined &&
        registered !== JSON.stringify([raw.path, raw.state, raw.byteLength, raw.sha256])
      )
        throw changed()
      return raw
    } catch {
      throw changed()
    }
  }

  private async withCopy<T>(
    runId: string,
    id: string,
    verify: boolean,
    use: (ref: ArtifactRef, file: FileHandle) => Promise<T>,
  ) {
    const { root } = await this.location(runId)
    const ref = await this.reference(root, runId, id)
    const file = await openWorkspaceArtifact(root, `artifacts/${id}/content.bin`).catch(() => {
      throw changed()
    })
    const key = runId + "/" + id
    try {
      const before = await file.stat({ bigint: true })
      if (before.size !== BigInt(ref.byteLength)) throw changed()
      const signature = ref.sha256 + "/" + stamp(before)
      const known = this.verified.get(key)
      if (verify || known === undefined) {
        if ((await hashFilePrefix(file, ref.byteLength)) !== ref.sha256) throw changed()
      } else if (known !== signature) throw changed()
      const result = await use(ref, file)
      if (stamp(await file.stat({ bigint: true })) !== stamp(before)) throw changed()
      this.verified.set(key, signature)
      return result
    } finally {
      await file.close()
    }
  }

  verify(runId: string, id: string) {
    return this.withCopy(runId, id, true, async (ref) => ref)
  }

  content(runId: string, id: string, query: ArtifactRangeQuery) {
    return this.withCopy(runId, id, false, async (ref, file) => ({
      ref,
      ...(await readArtifactRange(file, ref.byteLength, query)),
    }))
  }

  async list(runId: string, kind: "artifacts" | "experiments", after?: string, limit = 16) {
    if (
      (after !== undefined && !UUID.test(after)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32
    )
      throw new EvidenceError("invalid_query", "Invalid evidence cursor or page size")
    const { root } = await this.location(runId)
    const ids = (await entries(join(root, kind)))
      .flatMap((entry) => {
        const id =
          kind === "experiments" && entry.isFile() && entry.name.endsWith(".json")
            ? entry.name.slice(0, -5)
            : kind === "artifacts" && entry.isDirectory()
              ? entry.name
              : ""
        return UUID.test(id) && (!after || id > after) ? [id] : []
      })
      .sort()
    return {
      ids: ids.slice(0, limit),
      ...(ids.length > limit ? { nextCursor: ids[limit - 1] } : {}),
    }
  }

  record(runId: string, input: RegisterExperiment): Promise<ExperimentRecord> {
    return this.exclusive(async () => {
      const { root } = await this.location(runId)
      const inputs = [...new Set(input.inputRefs ?? [])]
      if (
        !statuses.includes(input.status) ||
        inputs.length > 16 ||
        (input.note !== undefined &&
          (typeof input.note !== "string" || input.note.length > 2000)) ||
        (input.exitCode !== undefined &&
          (input.status !== "exited" || !Number.isSafeInteger(input.exitCode)))
      )
        throw new EvidenceError("invalid_query", "Invalid experiment observation")
      const ids = new Set(
        [...inputs, input.scriptRef, input.stdoutRef, input.stderrRef].filter(
          (id): id is string => id !== undefined,
        ),
      )
      if (!ids.size)
        throw new EvidenceError("invalid_query", "The experiment requires a saved file reference")
      const refs = new Map<string, ArtifactRef>()
      for (const id of ids) refs.set(id, await this.withCopy(runId, id, false, async (ref) => ref))
      const record: ExperimentRecord = {
        version: 1,
        id: randomUUID(),
        runId,
        recordedBy: "operator",
        recordedAt: new Date().toISOString(),
        executionId: null,
        processSessionId: null,
        imageDigest: "unknown",
        instanceId: "unknown",
        status: input.status,
        exitCode: input.exitCode ?? null,
        inputs: inputs.map((id) => refs.get(id)!),
        script: input.scriptRef ? refs.get(input.scriptRef)! : null,
        stdoutRef: input.stdoutRef ?? null,
        stderrRef: input.stderrRef ?? null,
        ...(input.note ? { note: input.note } : {}),
      }
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_METADATA)
        throw new EvidenceError("invalid_query", "Experiment metadata is too large")
      const dir = await directory(join(root, "experiments"), true)
      const temp = join(dir, `.pending-${record.id}`)
      try {
        await writeJson(temp, record)
        await rename(temp, join(dir, record.id + ".json"))
      } finally {
        await rm(temp, { force: true })
      }
      this.runs.appendEvent(runId, "experiment_recorded", {
        experimentId: record.id,
        status: record.status,
        refIds: [...ids],
      })
      return record
    })
  }

  async experiment(runId: string, id: string): Promise<ExperimentRecord> {
    if (!UUID.test(id)) throw notFound()
    const { root } = await this.location(runId)
    try {
      await directory(join(root, "experiments"))
      const record = (await readJson(root, "experiments/" + id + ".json")) as ExperimentRecord
      if (
        record?.version !== 1 ||
        record.runId !== runId ||
        record.id !== id ||
        record.recordedBy !== "operator" ||
        !statuses.includes(record.status) ||
        (record.exitCode !== null &&
          (!Number.isSafeInteger(record.exitCode) || record.status !== "exited")) ||
        record.imageDigest !== "unknown" ||
        record.instanceId !== "unknown" ||
        record.executionId !== null ||
        record.processSessionId !== null ||
        !Number.isFinite(Date.parse(record.recordedAt)) ||
        (record.note !== undefined &&
          (typeof record.note !== "string" || record.note.length > 2000)) ||
        !Array.isArray(record.inputs) ||
        record.inputs.length > 16 ||
        !record.inputs.every((r) => r && UUID.test(r.refId) && isRef(r, runId, r.refId)) ||
        (record.script !== null &&
          !(
            record.script &&
            UUID.test(record.script.refId) &&
            isRef(record.script, runId, record.script.refId)
          )) ||
        [record.stdoutRef, record.stderrRef].some((r) => r !== null && !UUID.test(r))
      )
        throw changed()
      return record
    } catch (error) {
      if (missing(error)) throw notFound()
      throw changed()
    }
  }

  /** Project.open calls this before serving reads. A faulty Run cannot prevent others opening. */
  async recover(report: (runId: string, message: string) => void) {
    for (const run of this.runs.listRuns()) {
      let hasRegisteredEvidence = false
      try {
        const events = this.runs.events(run.id, "registered_evidence")
        hasRegisteredEvidence = events.length > 0
        const expected = new Set<string>()
        const recorded = new Set<string>()
        for (const event of events) {
          if (event.type === "artifact_registered") {
            const { refId, path, state, byteLength, sha256 } = event.data as ArtifactRef
            expected.add(refId)
            this.registrations.set(
              run.id + "/" + refId,
              JSON.stringify([path, state, byteLength, sha256]),
            )
          } else recorded.add((event.data as { experimentId: string }).experimentId)
        }
        const { root } = await this.location(run.id)
        for (const kind of ["artifacts", "experiments"] as const) {
          const dir = join(root, kind)
          const found = await entries(dir)
          if (!found.length) continue
          for (const entry of found) {
            try {
              if (entry.name.startsWith(".pending-") && UUID.test(entry.name.slice(9))) {
                await rm(join(dir, entry.name), { recursive: entry.isDirectory(), force: true })
              } else if (kind === "artifacts" && UUID.test(entry.name)) {
                const alreadyRegistered = expected.delete(entry.name)
                const ref = await this.verify(run.id, entry.name)
                if (!alreadyRegistered) this.register(ref)
              } else if (
                kind === "experiments" &&
                entry.name.endsWith(".json") &&
                UUID.test(entry.name.slice(0, -5))
              ) {
                const experiment = await this.experiment(run.id, entry.name.slice(0, -5))
                if (!recorded.delete(experiment.id))
                  this.runs.appendEvent(run.id, "experiment_recorded", {
                    experimentId: experiment.id,
                    status: experiment.status,
                    refIds: [
                      ...new Set(
                        [
                          ...experiment.inputs.map((r) => r.refId),
                          experiment.script?.refId,
                          experiment.stdoutRef,
                          experiment.stderrRef,
                        ].filter((id): id is string => Boolean(id)),
                      ),
                    ],
                  })
              }
            } catch {
              report(run.id, `Invalid saved evidence: ${entry.name}`)
            }
          }
        }
        for (const id of [...expected, ...recorded]) report(run.id, `Missing saved evidence: ${id}`)
      } catch (error) {
        if (hasRegisteredEvidence || !missing(error))
          report(run.id, "Unable to inspect saved evidence")
      }
    }
  }
}
