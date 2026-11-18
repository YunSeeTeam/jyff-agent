// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { WorkspaceFilesPanel } from "../src/pages/challenge/WorkspaceFilesPanel.tsx"

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

describe("Workspace 文件面板", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("自动展开小目录并保持大目录折叠", async () => {
    const listing = {
      files: [
        {
          path: "artifacts/scripts/exploit.py",
          size: 1536,
          modifiedAt: "2026-08-09T00:00:00.000Z",
          preview: { kind: "code", language: "python" },
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          path: `bulk/file-${index}.bin`,
          size: index,
          modifiedAt: "2026-08-09T00:00:00.000Z",
          preview: null,
        })),
        {
          path: "notes.md",
          size: 20,
          modifiedAt: "2026-08-09T00:00:00.000Z",
          preview: { kind: "markdown", language: "markdown" },
        },
      ],
      truncated: false,
    }
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/files/preview?path=artifacts")) {
        return jsonResponse({
          path: "artifacts/scripts/exploit.py",
          size: 18,
          kind: "code",
          language: "python",
          content: "print('pwn')",
        })
      }
      if (url.includes("/files/preview?path=notes.md")) {
        return jsonResponse({
          path: "notes.md",
          size: 20,
          kind: "markdown",
          language: "markdown",
          content: "# Report\n**confirmed**",
        })
      }
      return jsonResponse(listing)
    })
    vi.stubGlobal("fetch", fetchMock)

    render(
      createElement(WorkspaceFilesPanel, {
        projectId: "demo/project",
        challengeId: "pwn/1",
      }),
    )

    const user = userEvent.setup()
    const artifacts = await screen.findByRole("button", {
      name: "折叠 artifacts",
    })
    expect(screen.queryByText("Workspace 文件")).toBeNull()
    expect(artifacts.getAttribute("aria-expanded")).toBe("true")
    const scripts = screen.getByRole("button", {
      name: "折叠 artifacts/scripts",
    })
    expect(scripts.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("exploit.py")).toBeTruthy()
    expect(screen.getByText("1.5 KiB")).toBeTruthy()

    const bulk = screen.getByRole("button", { name: "展开 bulk" })
    expect(bulk.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("file-0.bin")).toBeNull()
    await user.click(bulk)
    expect(screen.getByText("file-0.bin")).toBeTruthy()
    const download = screen.getByRole("link", {
      name: "下载 artifacts/scripts/exploit.py",
    })
    expect(download.getAttribute("href")).toBe(
      "/api/projects/demo%2Fproject/challenges/pwn%2F1/files/download?path=artifacts%2Fscripts%2Fexploit.py",
    )

    await user.click(
      screen.getByRole("button", {
        name: "预览 artifacts/scripts/exploit.py",
      }),
    )
    expect(await screen.findByRole("heading", { name: "exploit.py" })).toBeTruthy()
    expect(await screen.findByText("print")).toBeTruthy()
    expect(document.querySelector(".hljs-built_in")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "关闭预览" }))
    await waitFor(() => expect(screen.queryByRole("heading", { name: "exploit.py" })).toBeNull())

    await user.click(screen.getByRole("button", { name: "预览 notes.md" }))
    expect(await screen.findByRole("heading", { name: "Report" })).toBeTruthy()
    expect(screen.getByText("confirmed")).toBeTruthy()
  })

  it("在选中的 Run 保存快照，按字节翻页并登记人工观察", async () => {
    const ref = {
      refId: "file-1",
      path: "notes.txt",
      sha256: "a".repeat(64),
      byteLength: 8,
      state: "final",
    }
    const record = {
      id: "obs-1",
      recordedAt: "2026-11-18",
      status: "unknown",
      exitCode: null,
      note: "复核",
    }
    const calls: Array<[string, string | null]> = []
    const base = "/api/projects/local/runs/r1"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url)
        const body = typeof init?.body === "string" ? init.body : null
        calls.push([path, body])
        if (path.endsWith("/files")) return jsonResponse({ files: [], truncated: false })
        if (path.includes("/content?")) {
          const at = Number(new URL(path, "http://local").searchParams.get("offset"))
          return jsonResponse({
            ref,
            offset: at,
            nextOffset: at + 4,
            encoding: "base64",
            content: at ? "RUZHSA==" : "QUJDRA==",
            byteLength: 8,
            hasMore: !at,
          })
        }
        if (body && path.endsWith("/artifacts")) return jsonResponse(ref)
        if (body && path.endsWith("/experiments")) return jsonResponse(record)
        return jsonResponse({ ids: [] })
      }),
    )
    render(
      createElement(WorkspaceFilesPanel, {
        projectId: "local",
        challengeId: "sample",
        runId: "r1",
      }),
    )
    const user = userEvent.setup()
    await user.click(await screen.findByText("本次 Run 的文件快照与实验记录"))
    await user.type(await screen.findByLabelText("工作区文件路径"), "notes.txt")
    await user.click(screen.getByRole("button", { name: "保存快照" }))
    expect(await screen.findByText("QUJDRA==")).toBeTruthy()
    expect(calls).toContainEqual([base + "/artifacts", JSON.stringify({ path: "notes.txt" })])
    await user.click(screen.getByRole("button", { name: "下一页" }))
    expect(await screen.findByText("RUZHSA==")).toBeTruthy()
    expect(calls).toContainEqual([
      base + "/artifacts/file-1/content?offset=4&encoding=base64",
      null,
    ])
    await user.type(screen.getByLabelText("实验备注"), "复核")
    await user.click(screen.getByRole("button", { name: "以此快照登记实验" }))
    expect(await screen.findByText("已登记人工实验记录")).toBeTruthy()
    expect(calls).toContainEqual([
      base + "/experiments",
      JSON.stringify({ inputRefs: ["file-1"], status: "unknown", note: "复核" }),
    ])
  })
})
