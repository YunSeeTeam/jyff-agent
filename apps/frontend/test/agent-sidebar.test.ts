// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { AgentSidebar } from "../src/pages/challenge/AgentSidebar.tsx"
import type { ChallengeDetails } from "../src/types.ts"

const endpoint =
  "https://instance.example.test/very/long/environment/path/that/must/not/overflow/the/sidebar"

afterEach(cleanup)

describe("AgentSidebar", () => {
  it("根据选中 Agent 按需展示用量详情", () => {
    const { rerender } = renderSidebar("worker-1")

    expect(screen.getAllByText("Explorer Worker")).toHaveLength(2)
    expect(screen.queryByText("75%")).toBeNull()
    fireEvent.click(screen.getByText("用量详情"))
    expect(screen.getByText("75%")).toBeTruthy()
    expect(screen.getByText("100 tokens")).toBeTruthy()
    expect(screen.getByText("300 tokens")).toBeTruthy()
    expect(screen.getByText("20 tokens")).toBeTruthy()

    rerender(sidebar(null))
    expect(screen.getAllByText("Solver")).toHaveLength(2)
    expect(screen.getByText("50%")).toBeTruthy()
    expect(screen.getAllByText("200 tokens")).toHaveLength(2)
  })

  it("首页之外的 SubAgent 按需加载", () => {
    const onLoadMore = vi.fn()
    const run = details.runs[0]
    if (!run) throw new Error("fixture")
    const paged = {
      ...details,
      runs: [{ ...run, subagentCount: 40, subagentsNextCursor: "cursor-1" }],
    } as ChallengeDetails
    render(sidebar(null, paged, onLoadMore))
    expect(screen.getByText("40")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "加载其余 39 个 SubAgent" }))
    expect(onLoadMore).toHaveBeenCalledWith("run-1")
  })

  it("SubAgent 报告只在点击后按页读取，版本变化时从首页重读", async () => {
    const run = details.runs[0]
    const worker = run?.subagents[0]
    if (!run || !worker) throw new Error("fixture")
    const withReport = {
      ...details,
      runs: [
        {
          ...run,
          subagents: [{ ...worker, resultVersion: "v1:a", totalLength: 9_000, hasMore: true }],
        },
      ],
    } as ChallengeDetails
    const page = (body: object, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        page({ resultVersion: "v1:a", result: "first-page ", nextOffset: 8_000, hasMore: true }),
      )
      .mockResolvedValueOnce(page({ error: "result_changed", message: "changed" }, 409))
      .mockResolvedValueOnce(page({ resultVersion: "v1:b", result: "rewritten", hasMore: false }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      render(sidebar("worker-1", withReport))
      // Nothing is fetched until the user asks for the report.
      expect(fetchMock).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole("button", { name: "查看报告" }))
      await waitFor(() => expect(screen.getByText("first-page")).toBeTruthy())
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "/api/projects/project-1/runs/run-1/subagents/worker-1/result",
      )

      fireEvent.click(screen.getByRole("button", { name: "继续读取" }))
      await waitFor(() => expect(screen.getByText("rewritten")).toBeTruthy())
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        "offset=8000&expectedResultVersion=v1%3Aa",
      )
      // Pages of two reports are never joined.
      expect(screen.queryByText(/first-page/)).toBeNull()
      expect(screen.queryByRole("button", { name: "继续读取" })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("截断展示并复制完整环境 URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    renderSidebar(null)

    expect(screen.getByText("运行中")).toBeTruthy()
    const url = screen.getByTitle(endpoint)
    expect(url.className).toContain("truncate")
    expect(url.className).toContain("min-w-0")
    fireEvent.click(screen.getByRole("button", { name: "复制环境 URL" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(endpoint))
    expect(screen.getByRole("button", { name: "环境 URL 已复制" })).toBeTruthy()
    expect(url.parentElement?.parentElement?.className).toContain("minmax(0,1fr)")
  })

  it("区分平台未提供与明确不需要环境", () => {
    const unknownEnvironment = {
      ...details,
      challenge: { ...details.challenge, needsEnv: undefined },
      environment: null,
    } as ChallengeDetails
    const { rerender } = render(sidebar(null, unknownEnvironment))

    expect(screen.getByText("平台未提供")).toBeTruthy()

    rerender(
      sidebar(null, {
        ...unknownEnvironment,
        challenge: { ...unknownEnvironment.challenge, needsEnv: false },
      }),
    )
    expect(screen.getByText("不需要")).toBeTruthy()
  })
})

function renderSidebar(selectedSubagentId: string | null) {
  return render(sidebar(selectedSubagentId))
}

function sidebar(
  selectedSubagentId: string | null,
  challengeDetails: ChallengeDetails = details,
  onLoadMoreSubagents = vi.fn(),
) {
  return createElement(AgentSidebar, {
    projectId: "project-1",
    details: challengeDetails,
    selectedRunId: "run-1",
    selectedSubagentId,
    onSelectSubagent: vi.fn(),
    onLoadMoreSubagents,
  })
}

const details = {
  challenge: {
    id: "pwn-1",
    attempts: 1,
    sessionInterruptions: 0,
    platformSolved: false,
    needsEnv: true,
  },
  environment: {
    id: "env-1",
    challengeId: "pwn-1",
    status: "running",
    endpoint,
  },
  runs: [
    {
      id: "run-1",
      attempt: 1,
      status: "running",
      cache: {
        inputTokens: 200,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        cacheRate: 0.5,
      },
      subagentCount: 1,
      subagents: [
        {
          id: "worker-1",
          displayName: "Explorer Worker",
          role: "explorer",
          status: "running",
          usage: {
            turns: 2,
            toolUses: 0,
            totalTokens: 500,
            inputTokens: 100,
            cacheReadTokens: 300,
            cacheWriteTokens: 20,
          },
        },
      ],
    },
  ],
} as unknown as ChallengeDetails
