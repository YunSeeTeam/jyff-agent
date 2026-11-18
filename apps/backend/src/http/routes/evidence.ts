import { EvidenceError, type ArtifactRangeQuery } from "@ctf-agent/core"
import { Hono } from "hono"
import { z } from "zod"
import type { App, AppContext, AppEnv } from "../context.ts"
import { HttpError } from "../errors.ts"
import { parseJsonBody } from "../schema.ts"
import type { Services } from "../services.ts"

const capture = z.strictObject({
  path: z.string().min(1).max(1024),
  prefixBytes: z.number().int().nonnegative().optional(),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
const ref = z.uuidv4()
const observation = z.strictObject({
  processSessionId: ref.optional(),
  inputRefs: z.array(ref).max(16).optional(),
  scriptRef: ref.optional(),
  stdoutRef: ref.optional(),
  stderrRef: ref.optional(),
  status: z.enum(["unknown", "exited", "interrupted", "failed"]),
  exitCode: z.number().int().optional(),
  note: z.string().max(2000).optional(),
})
const statuses: Record<EvidenceError["code"], number> = {
  artifact_not_found: 404,
  invalid_offset: 400,
  invalid_query: 400,
  invalid_encoding: 422,
  artifact_changed: 409,
  artifact_storage_limit: 413,
  evidence_unavailable: 503,
}

function query(c: AppContext, allowed: readonly string[]) {
  const params = new URL(c.req.url).searchParams
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1)
      throw new HttpError(400, "invalid_query", "未知或重复的分页参数")
  }
  return params
}

function integer(value: string | null) {
  if (value === null) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new HttpError(400, "invalid_query", "分页参数需要非负整数")
  return Number(value)
}

export function evidenceRoutes(services: Services): App {
  const app = new Hono<AppEnv>()
  function scopedProject(c: AppContext) {
    const id = c.get("scope")!.projectId
    const project = services.currentProject(id)
    if (!project || (project.config && project.config.project.id !== id))
      throw new HttpError(404, "project_not_found", "项目不存在")
    return project
  }
  function evidence(c: AppContext) {
    const project = scopedProject(c)
    if (!project.evidence) throw new HttpError(503, "evidence_unavailable", "项目证据存储不可用")
    return project.evidence
  }
  function range(q: URLSearchParams): ArtifactRangeQuery {
    const encoding = q.get("encoding") ?? "base64"
    if (encoding !== "base64" && encoding !== "utf8")
      throw new HttpError(400, "invalid_query", "不支持的编码")
    return { offset: integer(q.get("offset")), limitBytes: integer(q.get("limitBytes")), encoding }
  }
  // Storage errors may contain host paths. Only expose the public error contract.
  async function response<T>(c: AppContext, operation: Promise<T>, status: 200 | 201 = 200) {
    try {
      const data = await operation
      c.header("Cache-Control", "no-store")
      return c.json(data, status)
    } catch (error) {
      if (error instanceof EvidenceError)
        throw new HttpError(statuses[error.code], error.code, error.message)
      throw new HttpError(503, "evidence_unavailable", "无法访问该 Run 的证据文件")
    }
  }
  for (const kind of ["artifacts", "experiments"] as const) {
    app.get(`/runs/:runId/${kind}`, (c) => {
      const q = query(c, ["cursor", "limit"])
      return response(
        c,
        evidence(c).list(
          c.req.param("runId"),
          kind,
          q.get("cursor") ?? undefined,
          integer(q.get("limit")),
        ),
      )
    })
  }
  app.post("/runs/:runId/artifacts", async (c) => {
    const body = await parseJsonBody(c, capture, { code: "invalid_query", maximumSize: 8192 })
    return response(c, evidence(c).capture(c.req.param("runId"), body), 201)
  })
  app.get("/runs/:runId/artifacts/:refId/content", (c) => {
    const q = query(c, ["offset", "limitBytes", "encoding"])
    return response(c, evidence(c).content(c.req.param("runId"), c.req.param("refId"), range(q)))
  })
  app.get("/runs/:runId/fixed-attachments/:sessionId/log", (c) => {
    const q = query(c, ["stream", "offset", "limitBytes", "encoding"])
    const stream = q.get("stream")
    if (stream !== "stdout" && stream !== "stderr")
      throw new HttpError(400, "invalid_query", "请选择 stdout 或 stderr")
    return response(
      c,
      evidence(c).fixedAttachmentLog(
        c.req.param("runId"),
        c.req.param("sessionId"),
        stream,
        range(q),
      ),
    )
  })
  app.get("/runs/:runId/processes/:sessionId/log", (c) => {
    const q = query(c, ["stream", "offset", "limitBytes", "encoding"])
    const stream = q.get("stream")
    if (stream !== "stdout" && stream !== "stderr")
      throw new HttpError(400, "invalid_query", "请选择 stdout 或 stderr")
    return response(
      c,
      evidence(c).processLog(c.req.param("runId"), c.req.param("sessionId"), stream, range(q)),
    )
  })
  app.get("/challenges/:challengeId/files/range", (c) => {
    const project = scopedProject(c)
    const q = query(c, ["path", "offset", "limitBytes", "encoding"])
    const path = q.get("path")
    if (!path || path.length > 1024) throw new HttpError(400, "invalid_query", "工作区路径无效")
    if (!project.challengeWorkspaceRange)
      throw new HttpError(503, "evidence_unavailable", "项目不支持范围读取")
    return response(c, project.challengeWorkspaceRange(c.req.param("challengeId"), path, range(q)))
  })
  app.post("/runs/:runId/artifacts/:refId/verify", (c) =>
    response(c, evidence(c).verify(c.req.param("runId"), c.req.param("refId"))),
  )
  app.post("/runs/:runId/experiments", async (c) => {
    const body = await parseJsonBody(c, observation, { code: "invalid_query", maximumSize: 16384 })
    return response(c, evidence(c).record(c.req.param("runId"), body), 201)
  })
  app.get("/runs/:runId/experiments/:id", (c) =>
    response(c, evidence(c).experiment(c.req.param("runId"), c.req.param("id"))),
  )
  return app
}
