import type {
  BlackboardKind,
  BlackboardReadResult,
  BlackboardFullEntry,
} from "@ctf-agent/core/contracts"
import { useEffect, useState } from "react"
import { Button, Badge } from "../../components/index.ts"
import { apiRequest, projectApi } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"

export function BlackboardReaderPanel({
  projectId,
  challengeId,
}: {
  projectId: string
  challengeId: string
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" key={`${projectId}:${challengeId}`}>
      <BlackboardKindPanel projectId={projectId} challengeId={challengeId} kind="evidence" />
      <BlackboardKindPanel projectId={projectId} challengeId={challengeId} kind="opportunity" />
    </div>
  )
}

function BlackboardKindPanel({
  projectId,
  challengeId,
  kind,
}: {
  projectId: string
  challengeId: string
  kind: BlackboardKind
}) {
  const [page, setPage] = useState<BlackboardReadResult | null>(null)
  const [entries, setEntries] = useState<BlackboardReadResult["entries"]>([])
  const [full, setFull] = useState<Record<number, BlackboardFullEntry>>({})
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const url = projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/blackboard`)
  useEffect(() => {
    let active = true
    setLoading(true)
    void apiRequest<BlackboardReadResult>(`${url}?kind=${kind}`)
      .then((next) => {
        if (active) {
          setPage(next)
          setEntries(next.entries)
          setFull({})
          setError("")
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [url, kind])
  const read = async (id?: number) => {
    setLoading(true)
    setError("")
    try {
      const query = id === undefined ? `afterId=${page?.nextAfterId ?? 0}` : `view=full&ids=${id}`
      const next = await apiRequest<BlackboardReadResult>(`${url}?kind=${kind}&${query}`)
      if (id !== undefined) {
        const entry = next.entries[0] as BlackboardFullEntry | undefined
        if (entry) setFull((old) => ({ ...old, [id]: entry }))
        else {
          setFull((old) => {
            const copy = { ...old }
            delete copy[id]
            return copy
          })
          setError(`条目 ${id} 已不存在`)
        }
      } else {
        setPage(next)
        setEntries((old) => [
          ...new Map([...old, ...next.entries].map((entry) => [entry.id, entry])).values(),
        ])
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }
  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <h3 className="flex-1 text-sm font-medium">
          {kind === "evidence" ? "已记录的证据与观察" : "待验证机会"}
        </h3>
        <Badge>
          {kind === "evidence" ? (page?.counts?.evidence ?? 0) : (page?.counts?.opportunities ?? 0)}
        </Badge>
      </div>
      <div className="max-h-96 overflow-auto">
        {entries.map((item) => (
          <div key={item.id} className="space-y-2 border-b border-border p-3 text-xs">
            <span className="font-mono">
              {kind === "evidence" ? "E" : "O"}-{item.id}
            </span>
            <p className="whitespace-pre-wrap break-words">
              {full[item.id]?.description ?? ("preview" in item ? item.preview : item.description)}
            </p>
            <p className="text-muted-foreground">
              来源 Run：{item.creatorRunId ?? "未知"} · {item.createdAt ?? "时间未知"}
              {item.status ? ` · ${item.status}` : ""}
            </p>
            {full[item.id]?.sourceEvidenceIds ? (
              <p>依据：{full[item.id]!.sourceEvidenceIds!.map((id) => `E-${id}`).join(", ")}</p>
            ) : null}
            {full[item.id]?.resolution ? (
              <p>
                结论：{full[item.id]!.resolution}
                {full[item.id]?.targetEvidenceId ? ` → E-${full[item.id]!.targetEvidenceId}` : ""}
              </p>
            ) : null}
            <p className="break-all font-mono text-[10px] text-muted-foreground">
              {full[item.id]?.contentHash ?? item.contentHash}
            </p>
            {full[item.id] && full[item.id]!.contentHash !== item.contentHash ? (
              <p className="text-warning">内容已更新，以本次读取为准</p>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void read(item.id)}
            >
              {full[item.id] ? "重新读取" : "查看完整条目"}
            </Button>
          </div>
        ))}
      </div>
      {error ? <p className="p-3 text-xs text-danger">{error}</p> : null}
      {page?.hasMore ? (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void read()}>
          加载更多
        </Button>
      ) : null}
    </section>
  )
}
