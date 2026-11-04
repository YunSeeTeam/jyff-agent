// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { useChallengeDetails } from "../src/hooks/useChallengeDetails.ts"
import { useSse } from "../src/hooks/useSse.ts"
import { ChallengePage } from "../src/pages/ChallengePage.tsx"

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  readonly close = vi.fn()
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>)
    }
  }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  FakeEventSource.instances = []
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useSse", () => {
  it("解析有效事件、忽略损坏帧，并在 URL 变更时关闭旧连接", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const received: unknown[] = []
    const { rerender, unmount } = render(
      createElement(SseProbe, {
        url: "/api/projects/one/events",
        onSnapshot: (value) => received.push(value),
      }),
    )
    const first = FakeEventSource.instances[0]
    if (!first) throw new Error("SSE connection was not created")

    act(() => first.emit("snapshot", '{"projectId":"one"}'))
    act(() => first.emit("snapshot", "not-json"))
    expect(received).toEqual([{ projectId: "one" }])

    rerender(
      createElement(SseProbe, {
        url: "/api/projects/two/events",
        onSnapshot: (value) => received.push(value),
      }),
    )
    expect(first.close).toHaveBeenCalledOnce()
    expect(FakeEventSource.instances[1]?.url).toBe("/api/projects/two/events")

    unmount()
    expect(FakeEventSource.instances[1]?.close).toHaveBeenCalledOnce()
  })
})

describe("useChallengeDetails", () => {
  it("按 Project 隔离详情，并在 snapshot 与派发后重新读取权威状态", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const responses = [
      details("one", "before snapshot"),
      details("one", "after snapshot"),
      details("one", "after dispatch"),
      details("two", "other project"),
    ]
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (init?.method === "POST") {
        expect(url).toBe("/api/projects/one/challenges/web-1/dispatch")
        return jsonResponse({})
      }
      const response = responses.shift()
      if (!response) throw new Error(`unexpected request: ${url}`)
      return jsonResponse(response)
    })
    vi.stubGlobal("fetch", fetchMock)

    const { rerender } = render(
      createElement(ChallengeDetailsProbe, {
        projectId: "one",
        challengeId: "web-1",
      }),
    )
    expect(await screen.findByText("before snapshot")).toBeTruthy()
    const first = FakeEventSource.instances[0]
    if (!first) throw new Error("challenge SSE connection was not created")
    expect(first.url).toBe("/api/projects/one/events")

    act(() => first.emit("snapshot", "{}"))
    expect(await screen.findByText("after snapshot")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "dispatch" }))
    expect(await screen.findByText("after dispatch")).toBeTruthy()

    rerender(
      createElement(ChallengeDetailsProbe, {
        projectId: "two",
        challengeId: "web-1",
      }),
    )
    expect(await screen.findByText("other project")).toBeTruthy()
    expect(first.close).toHaveBeenCalledOnce()
    await waitFor(() => expect(FakeEventSource.instances[1]?.url).toBe("/api/projects/two/events"))
  })

  it("按需读取首页之外的 SubAgent，并随后续刷新一起更新", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const summary = (id: string, status = "completed") => ({
      id,
      runId: "run-1",
      role: "recon",
      displayName: id,
      status,
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      usage: { turns: 1, toolUses: 0, totalTokens: 1 },
      task: "t",
      taskTruncated: false,
      hasMore: false,
    })
    const withRun = (progress: string) => ({
      ...details("one", progress),
      runs: [
        {
          id: "run-1",
          subagents: [{ ...summary("agent-a"), hasConversation: true }],
          subagentCount: 3,
          subagentsNextCursor: "c1",
        },
      ],
    })
    const requested: string[] = []
    let laterStatus = "running"
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requested.push(url)
      if (url.endsWith("/challenges/web-1")) return jsonResponse(withRun("loaded"))
      if (url.includes("cursor=c1")) {
        return jsonResponse({ items: [summary("agent-b")], nextCursor: "c2", omittedCount: 1 })
      }
      if (url.includes("cursor=c2")) {
        return jsonResponse({ items: [summary("agent-c", laterStatus)], omittedCount: 0 })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(createElement(SubagentPagesProbe, { projectId: "one", challengeId: "web-1" }))
    expect(await screen.findByText("agent-a:completed")).toBeTruthy()
    // Only the details page is read until the user asks for more.
    expect(requested).toEqual(["/api/projects/one/challenges/web-1"])

    fireEvent.click(screen.getByRole("button", { name: "more" }))
    expect(await screen.findByText("agent-c:running")).toBeTruthy()
    expect(screen.getAllByText(/^agent-/).map((node) => node.textContent)).toEqual([
      "agent-a:completed",
      "agent-b:completed",
      "agent-c:running",
    ])
    expect(requested[1]).toBe("/api/projects/one/runs/run-1/subagents?limit=32&cursor=c1")

    laterStatus = "completed"
    const source = FakeEventSource.instances[0]
    if (!source) throw new Error("challenge SSE connection was not created")
    act(() => source.emit("snapshot", "{}"))
    expect(await screen.findByText("agent-c:completed")).toBeTruthy()
  })

  it("已解出的题目显示强制派发确认，并显式提交 force", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    let dispatchBody: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (init?.method === "POST") {
          expect(url).toBe("/api/projects/one/challenges/web-1/dispatch")
          if (typeof init.body !== "string") throw new Error("expected a JSON request body")
          dispatchBody = JSON.parse(init.body)
          return jsonResponse({})
        }
        return jsonResponse({
          ...details("one", "已经解出"),
          challenge: {
            ...details("one", "已经解出").challenge,
            status: "solved",
            platformSolved: true,
          },
        })
      }),
    )

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/projects/one/challenges/web-1"] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "/projects/:projectId/challenges/:challengeId",
            element: createElement(ChallengePage),
          }),
        ),
      ),
    )

    const forceButtons = await screen.findAllByRole("button", { name: "强制派发" })
    const forceButton = forceButtons[0]
    if (!forceButton) throw new Error("force dispatch button was not rendered")
    fireEvent.click(forceButton)
    expect(screen.getByText("强制派发已解出的题目？")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "确认强制派发" }))

    await waitFor(() => expect(dispatchBody).toEqual({ force: true }))
  })
})

function SseProbe({ url, onSnapshot }: { url: string; onSnapshot: (value: unknown) => void }) {
  useSse(url, { snapshot: onSnapshot })
  return null
}

function ChallengeDetailsProbe({
  projectId,
  challengeId,
}: {
  projectId: string
  challengeId: string
}) {
  const { details, challengeAction } = useChallengeDetails(projectId, challengeId)
  return createElement(
    "div",
    null,
    createElement("p", null, details?.challenge.progress ?? "loading"),
    createElement(
      "button",
      { type: "button", onClick: () => void challengeAction("dispatch") },
      "dispatch",
    ),
  )
}

function SubagentPagesProbe({
  projectId,
  challengeId,
}: {
  projectId: string
  challengeId: string
}) {
  const { details, loadMoreSubagents } = useChallengeDetails(projectId, challengeId)
  const run = details?.runs[0]
  return createElement(
    "div",
    null,
    ...(run?.subagents ?? []).map((subagent) =>
      createElement("p", { key: subagent.id }, `${subagent.id}:${subagent.status}`),
    ),
    createElement(
      "button",
      { type: "button", onClick: () => void loadMoreSubagents("run-1") },
      "more",
    ),
  )
}

function details(projectId: string, progress: string) {
  return {
    generatedAt: "2026-08-11T00:00:00.000Z",
    solverAvailable: true,
    challenge: {
      id: "web-1",
      title: `Challenge in ${projectId}`,
      category: "web",
      score: 100,
      status: "pending",
      platformSolved: false,
      attempts: 0,
      latestRunId: null,
      latestRunStatus: null,
      solveDurationMs: null,
      lastActivityAt: null,
      progress,
      queuePosition: null,
      dispatchSource: null,
      schedulerAttempts: 0,
      sessionInterruptions: 0,
      evidence: 0,
      openOpportunities: 0,
      concludedOpportunities: 0,
    },
    runs: [],
    blackboard: {},
    environment: null,
    writeup: {
      validation: { valid: false, path: "", errors: [], size: 0 },
      content: null,
    },
    tldr: null,
  }
}
