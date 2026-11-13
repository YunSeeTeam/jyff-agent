import { Icon } from "@iconify/react"
import { useEffect, useRef, useState } from "react"
import { Button, Card } from "../../components/index.ts"
import { ApiError, apiRequest, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"
import type { DashboardSubagent, SubagentResultPageDto } from "../../types.ts"

const KIND_LABELS: Record<string, string> = {
  assistant_final: "最终回复",
  assistant_partial: "未完成回复",
  tool_partial: "工具输出",
}

interface LoadedReport {
  version: string
  text: string
  nextOffset?: number
}

/**
 * A SubAgent report, read only when asked for and one page at a time. Pages
 * belong to one report version: a changed report discards them and starts
 * again, so text from two different reports is never joined.
 */
export function SubagentReport({
  projectId,
  runId,
  subagent,
}: {
  projectId: string
  runId: string
  subagent: DashboardSubagent
}) {
  const [report, setReport] = useState<LoadedReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const version = subagent.resultVersion
  const requestGeneration = useRef(0)

  useEffect(() => {
    setReport(null)
    setError("")
    setLoading(false)
    requestGeneration.current++
    return () => {
      requestGeneration.current++
    }
  }, [projectId, runId, subagent.id, version])

  const readPage = (offset: number, expectedVersion?: string) => {
    const query = new URLSearchParams()
    if (offset > 0) query.set("offset", String(offset))
    if (expectedVersion) query.set("expectedResultVersion", expectedVersion)
    const suffix = query.size > 0 ? `?${query.toString()}` : ""
    return apiRequest<SubagentResultPageDto>(
      projectApi(
        projectId,
        `/api/runs/${encodeURIComponent(runId)}/subagents/${encodeURIComponent(subagent.id)}/result${suffix}`,
      ),
    )
  }

  const loaded = (page: SubagentResultPageDto, previous = ""): LoadedReport => ({
    version: page.resultVersion,
    text: previous + page.result,
    ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
  })

  const run = async (read: () => Promise<LoadedReport>) => {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError("")
    try {
      const loadedReport = await read()
      if (generation === requestGeneration.current) setReport(loadedReport)
    } catch (cause) {
      if (generation === requestGeneration.current) setError(errorMessage(cause))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }

  const readFirst = () => run(async () => loaded(await readPage(0)))
  const readMore = () => {
    if (!report || report.nextOffset === undefined) return Promise.resolve()
    const { nextOffset, version: pageVersion, text } = report
    return run(async () => {
      try {
        return loaded(await readPage(nextOffset, pageVersion), text)
      } catch (cause) {
        // The report changed since the first page: drop what was read and start over.
        if (cause instanceof ApiError && cause.status === 409) return loaded(await readPage(0))
        throw cause
      }
    })
  }

  const kind = subagent.resultKind ? KIND_LABELS[subagent.resultKind] : undefined
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border px-3 py-2.5">
        <span className="flex items-center gap-2.5 whitespace-nowrap text-sm font-medium">
          <Icon icon="lucide:file-text" width="15" />
          SubAgent 报告
        </span>
        <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
          {kind ? `${kind} · ` : ""}
          {(subagent.totalLength ?? 0).toLocaleString()} 字符
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {report ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] text-foreground">
            {report.text}
          </pre>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {!report ? (
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void readFirst()}>
            查看报告
          </Button>
        ) : report.nextOffset !== undefined ? (
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void readMore()}>
            继续读取
          </Button>
        ) : null}
      </div>
    </Card>
  )
}
