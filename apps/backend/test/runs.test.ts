import type { SubagentRecord } from "@ctf-agent/core"
import { describe, expect, it } from "vite-plus/test"
import { createWebUiApp } from "../src/server.ts"
import type { DashboardConversation } from "../src/types.ts"
import { FakeDashboardProject } from "./fake-project.ts"
import { jsonOf, jsonRequest, readSseUntil } from "./helpers.ts"

describe("Run 与 SubAgent 会话路由", () => {
  it("按 Run 隔离转发实时 Agent 事件", async () => {
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })
    const response = await app.request("/api/runs/run-pwn-1/events")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await readSseUntil(response, "event: ready")).toContain("event: ready")
    expect(project.agentStreamSubscriptions).toHaveLength(1)

    project.agentStreamSubscriptions[0]?.listener({
      type: "tool_started",
      runId: "run-pwn-1",
      seq: 7,
      createdAt: "2026-08-09T10:00:00.000Z",
      toolCallId: "tool-7",
      toolName: "bash",
      args: { command: "file chall" },
    })
    const streamed = await readSseUntil(response, '"toolCallId":"tool-7"')
    expect(streamed).toContain("event: agent_event")
    expect(streamed).toContain('"toolName":"bash"')
    await response.body?.cancel()
  })

  it("拒绝订阅不存在的 Run 或 SubAgent", async () => {
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })

    expect((await app.request("/api/runs/missing/events")).status).toBe(404)
    expect((await app.request("/api/runs/run-pwn-1/subagents/missing/events")).status).toBe(404)
    expect(project.agentStreamSubscriptions).toHaveLength(0)
  })

  it("提供 SubAgent steer/cancel 控制 API", async () => {
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })

    const steered = await jsonRequest(
      app,
      "/api/runs/run-pwn-1/subagents/worker-pwn-1/steer",
      "POST",
      { message: "先验证泄漏稳定性" },
    )
    expect(steered.status).toBe(200)
    const summary = await jsonOf(steered)
    expect(summary).toMatchObject({
      id: "worker-pwn-1",
      task: expect.stringContaining("先验证泄漏稳定性"),
    })
    // A bounded summary, not the raw record: no prompt and no host paths.
    expect(summary).not.toHaveProperty("prompt")
    expect(summary).not.toHaveProperty("sessionPath")
    expect(summary).not.toHaveProperty("containerCwd")

    expect(
      (
        await jsonRequest(app, "/api/runs/run-pwn-1/subagents/worker-pwn-1/steer", "POST", {
          message: "   ",
        })
      ).status,
    ).toBe(400)

    const cancelled = await jsonRequest(
      app,
      "/api/runs/run-pwn-1/subagents/worker-pwn-1/cancel",
      "POST",
      {},
    )
    expect(cancelled.status).toBe(200)
    expect(await jsonOf(cancelled)).toMatchObject({
      id: "worker-pwn-1",
      status: "cancelled",
    })
  })

  it("SubAgent 列表按游标分页，每页不超过 16 KiB 且最终枚举全部（T19）", async () => {
    const project = new FakeDashboardProject()
    const records = manySubagents(40)
    project.subagentValues.set("run-pwn-1", records)
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })

    const seen: string[] = []
    let cursor: string | undefined
    for (let pages = 0; pages < 100; pages++) {
      const response = await app.request(
        `/api/runs/run-pwn-1/subagents${cursor ? `?cursor=${cursor}` : ""}`,
      )
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024)
      expect(body).not.toContain("QQQQ")
      expect(body).not.toContain("/sessions/")
      const page = JSON.parse(body) as { items: Array<{ id: string }>; nextCursor?: string }
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(records.map((record) => record.id))

    const tampered = await app.request("/api/runs/run-pwn-1/subagents?cursor=bogus")
    expect(tampered.status).toBe(400)
    expect(await jsonOf(tampered)).toMatchObject({ error: "invalid_query" })
    expect((await app.request("/api/runs/run-pwn-1/subagents?limit=33")).status).toBe(400)
    expect((await app.request("/api/runs/missing/subagents")).status).toBe(404)
  })

  it("SubAgent 报告按页读取，版本变化返回 409", async () => {
    const project = new FakeDashboardProject()
    const [record] = manySubagents(1, "x".repeat(9_000))
    if (!record) throw new Error("fixture")
    project.subagentValues.set("run-pwn-1", [record])
    const { app } = createWebUiApp({ project, frontendDist: "/nonexistent" })
    const base = `/api/runs/run-pwn-1/subagents/${record.id}/result`

    const first = await jsonOf(await app.request(base))
    expect(first).toMatchObject({ offset: 0, totalLength: 9_000, nextOffset: 8_000, hasMore: true })
    const version = String(first.resultVersion)
    const second = await jsonOf(
      await app.request(`${base}?offset=8000&expectedResultVersion=${encodeURIComponent(version)}`),
    )
    expect(second).toMatchObject({ offset: 8_000, result: "x".repeat(1_000), hasMore: false })

    const stale = await app.request(`${base}?offset=8000&expectedResultVersion=v1%3Astale`)
    expect(stale.status).toBe(409)
    expect(await jsonOf(stale)).toMatchObject({
      error: "result_changed",
      details: { retryable: true },
    })
    expect((await app.request(`${base}?offset=10`)).status).toBe(400)
    expect(
      (
        await app.request(
          `${base}?offset=9001&expectedResultVersion=${encodeURIComponent(version)}`,
        )
      ).status,
    ).toBe(400)
    expect((await app.request(`${base}?offset=-1`)).status).toBe(400)
    expect((await app.request("/api/runs/run-pwn-1/subagents/missing/result")).status).toBe(404)
  })

  it("HTML 导出仅接受明确的 Run 或 SubAgent 会话", async () => {
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({
      project,
      sessionHasConversation: async () => true,
      frontendDist: "/nonexistent",
    })

    const ambiguous = await app.request("/api/challenges/pwn-1/export")
    expect(ambiguous.status).toBe(404)
    expect(await jsonOf(ambiguous)).toMatchObject({
      error: "challenge_not_found",
    })

    const missingRun = await app.request("/api/runs/nope/export")
    expect(missingRun.status).toBe(404)
    expect(await jsonOf(missingRun)).toMatchObject({ error: "run_not_found" })

    const missingSubagent = await app.request("/api/runs/run-pwn-1/subagents/nope/export")
    expect(missingSubagent.status).toBe(404)
    expect(await jsonOf(missingSubagent)).toMatchObject({
      error: "subagent_not_found",
    })
  })

  it("尚未产生 Agent 对话的 Run 和 SubAgent 均拒绝导出", async () => {
    const project = new FakeDashboardProject()
    let exportCalls = 0
    const { app } = createWebUiApp({
      project,
      sessionHasConversation: async () => false,
      exportSessionHtml: async () => {
        exportCalls++
        return Buffer.from("<!doctype html>")
      },
      frontendDist: "/nonexistent",
    })

    for (const path of [
      "/api/runs/run-pwn-1/export",
      "/api/runs/run-pwn-1/subagents/worker-pwn-1/export",
    ]) {
      const response = await app.request(path)
      expect(response.status).toBe(409)
      expect(await jsonOf(response)).toMatchObject({
        error: "session_not_ready",
      })
    }
    expect(exportCalls).toBe(0)
  })

  it("Run 与 SubAgent 使用各自的 Pi JSONL 导出 HTML", async () => {
    const project = new FakeDashboardProject()
    const sessionExports: Array<{
      sessionPath: string
      systemPrompt?: string
      toolNames?: string[]
    }> = []
    const { app } = createWebUiApp({
      project,
      sessionHasConversation: async () => true,
      exportSessionHtml: async (sessionPath, metadata) => {
        sessionExports.push({
          sessionPath,
          systemPrompt: metadata?.systemPrompt,
          toolNames: metadata?.tools.map((tool) => tool.name),
        })
        return Buffer.from("<!doctype html><title>Pi Session</title>")
      },
      frontendDist: "/nonexistent",
    })

    const runExport = await app.request("/api/runs/run-pwn-1/export")
    expect(runExport.status).toBe(200)
    expect(runExport.headers.get("content-type")).toContain("text/html")
    expect(runExport.headers.get("content-disposition")).toBeNull()
    expect(await runExport.text()).toContain("<title>Pi Session")

    const subagentExport = await app.request("/api/runs/run-pwn-1/subagents/worker-pwn-1/export")
    expect(subagentExport.status).toBe(200)
    expect(await subagentExport.text()).toContain("<title>Pi Session")
    expect(sessionExports).toEqual([
      {
        sessionPath: "/sessions/run-pwn-1/session.jsonl",
        systemPrompt: "You are a CTF solver.",
        toolNames: ["ctf_submit_flag"],
      },
      {
        sessionPath: "/sessions/worker-pwn-1/session.jsonl",
        systemPrompt: undefined,
        toolNames: undefined,
      },
    ])
  })

  it("Run 与 SubAgent 通过同一结构化 API 返回当前 Pi 对话", async () => {
    const project = new FakeDashboardProject()
    const reads: string[] = []
    const { app } = createWebUiApp({
      project,
      readSessionConversation: (sessionPath): DashboardConversation => {
        reads.push(sessionPath)
        return {
          messages: [
            {
              entryId: "assistant-1",
              timestamp: "2026-08-01T00:00:00.000Z",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "found offset" }],
                api: "openai-completions",
                provider: "test",
                model: "test-model",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "stop",
                timestamp: 1,
              },
            },
          ],
        }
      },
      frontendDist: "/nonexistent",
    })

    const run = await app.request("/api/runs/run-pwn-1/conversation")
    const subagent = await app.request("/api/runs/run-pwn-1/subagents/worker-pwn-1/conversation")

    expect(run.status).toBe(200)
    expect(await jsonOf(run)).toMatchObject({
      messages: [{ message: { role: "assistant" } }],
    })
    expect(subagent.status).toBe(200)
    expect(reads).toEqual([
      "/sessions/run-pwn-1/session.jsonl",
      "/sessions/worker-pwn-1/session.jsonl",
    ])
  })

  it("尚未产生 assistant 消息时结构化对话也不可查看", async () => {
    const project = new FakeDashboardProject()
    const { app } = createWebUiApp({
      project,
      readSessionConversation: () => ({
        messages: [
          {
            entryId: "user-1",
            timestamp: "2026-08-01T00:00:00.000Z",
            message: { role: "user", content: "start", timestamp: 1 },
          },
        ],
      }),
      frontendDist: "/nonexistent",
    })

    const response = await app.request("/api/runs/run-pwn-1/conversation")
    expect(response.status).toBe(409)
    expect(await jsonOf(response)).toMatchObject({ error: "session_not_ready" })
  })

  it("导出响应内联呈现，平台/run 数据不进入任何响应头（防 header 注入）", async () => {
    const project = new FakeDashboardProject()
    project.runValues.push({
      id: 'run"evil"1',
      challengeId: 'pwn"1;../evil',
      workspace: "/workspace/run-evil-1",
      attempt: 1,
      source: "manual",
      status: "running",
      writeupStatus: "not_requested",
      createdAt: "2026-07-29T12:06:00.000Z",
      updatedAt: "2026-07-29T12:06:00.000Z",
    })
    const { app } = createWebUiApp({
      project,
      sessionHasConversation: async () => true,
      exportSessionHtml: async () => Buffer.from("<!doctype html>"),
      frontendDist: "/nonexistent",
    })

    const response = await app.request(`/api/runs/${encodeURIComponent('run"evil"1')}/export`)
    expect(response.status).toBe(200)
    // 内联页面不带下载文件名，因此平台/run 数据完全不会出现在响应头。
    expect(response.headers.get("content-disposition")).toBeNull()
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(await response.text()).toContain("<!doctype html>")
  })
})

function manySubagents(count: number, result = "報".repeat(7_000)): SubagentRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 10, 4, 0, 0, index)).toISOString()
    return {
      id: `worker-${String(index).padStart(3, "0")}`,
      runId: "run-pwn-1",
      role: "pwn",
      displayName: "Pwn",
      description: "任".repeat(240),
      status: "completed",
      background: true,
      prompt: "Q".repeat(32_000),
      sessionPath: `/sessions/worker-${index}/session.jsonl`,
      containerCwd: `/workspace/subagents/worker-${index}`,
      result,
      turns: 1,
      toolUses: 1,
      totalTokens: 10,
      createdAt,
      updatedAt: createdAt,
    }
  })
}
