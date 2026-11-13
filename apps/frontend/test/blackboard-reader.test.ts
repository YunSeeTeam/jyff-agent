// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { BlackboardReaderPanel } from "../src/pages/challenge/BlackboardReaderPanel.tsx"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe("paged blackboard", () => {
  it("ignores delayed responses from a previously selected challenge", async () => {
    const old: Array<(value: Response) => void> = []
    const page = (preview: string) =>
      Response.json({
        schemaVersion: 2,
        kind: "evidence",
        view: "index",
        readAt: "now",
        entries: [
          {
            id: 1,
            preview,
            previewComplete: true,
            creatorRunId: "run",
            createdAt: "now",
            contentHash: "v1:test",
          },
        ],
        hasMore: false,
        missingIds: [],
        omittedIds: [],
      })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("/old/")
          ? new Promise<Response>((resolve) => old.push(resolve))
          : Promise.resolve(page("new observation")),
      ),
    )
    const { rerender } = render(
      createElement(BlackboardReaderPanel, { projectId: "demo", challengeId: "old" }),
    )
    rerender(createElement(BlackboardReaderPanel, { projectId: "demo", challengeId: "new" }))
    await screen.findAllByText("new observation")
    await act(async () => {
      old.forEach((resolve) => resolve(page("old observation")))
    })
    expect(screen.queryByText("old observation")).toBeNull()
    expect(screen.getAllByText("new observation")).toHaveLength(2)
  })

  it("loads indexes only, fetches full records on demand, and continues the ID cursor", async () => {
    const fetch = vi.fn(async (url: string) => {
      const base = {
        schemaVersion: 2,
        kind: "evidence",
        view: "index",
        readAt: "now",
        missingIds: [],
        omittedIds: [],
        hasMore: false,
        counts: { evidence: 2, opportunities: 0 },
      }
      const entry = { id: 1, creatorRunId: "r1", createdAt: "2026-01-01", contentHash: "v1:test" }
      if (url.includes("kind=opportunity"))
        return Response.json({ ...base, kind: "opportunity", entries: [] })
      if (url.includes("view=full"))
        return Response.json({
          ...base,
          view: "full",
          entries: [{ ...entry, description: "complete observation" }],
        })
      if (url.includes("afterId=1"))
        return Response.json({
          ...base,
          entries: [{ ...entry, id: 2, preview: "second", previewComplete: true }],
        })
      return Response.json({
        ...base,
        hasMore: true,
        nextAfterId: 1,
        entries: [{ ...entry, preview: "preview", previewComplete: false }],
      })
    })
    vi.stubGlobal("fetch", fetch)
    render(createElement(BlackboardReaderPanel, { projectId: "demo", challengeId: "c1" }))
    await screen.findByText("preview")
    expect(fetch.mock.calls).toHaveLength(2)
    expect(fetch.mock.calls.some(([url]) => url.includes("view=full"))).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "查看完整条目" }))
    await screen.findByText("complete observation")
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "加载更多" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }))
    await screen.findByText("second")
    expect(fetch.mock.calls.some(([url]) => url.includes("afterId=1"))).toBe(true)
    expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull()
  })
})
