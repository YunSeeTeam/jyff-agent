// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { SubagentReport } from "../src/pages/challenge/SubagentReport.tsx"
import type { DashboardSubagent } from "../src/types.ts"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it("discards a delayed page from an execution replaced while the request was in flight", async () => {
  let resolve!: (value: Response) => void
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    ),
  )
  const props = (version: string) => ({
    projectId: "project",
    runId: "run",
    subagent: { id: "worker", resultVersion: version, totalLength: 5 } as DashboardSubagent,
  })
  const { rerender } = render(createElement(SubagentReport, props("v1:old")))
  fireEvent.click(screen.getByRole("button", { name: "查看报告" }))
  rerender(createElement(SubagentReport, props("v1:new")))
  resolve(
    new Response(
      JSON.stringify({ resultVersion: "v1:old", result: "stale body", hasMore: false }),
      { headers: { "content-type": "application/json" } },
    ),
  )
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "查看报告" }).hasAttribute("disabled")).toBe(false),
  )
  expect(screen.queryByText("stale body")).toBeNull()
})
