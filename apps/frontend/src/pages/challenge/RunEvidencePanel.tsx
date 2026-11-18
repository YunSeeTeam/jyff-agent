import type { ArtifactPage, ArtifactRef, ExperimentRecord } from "@ctf-agent/core"
import { useEffect, useId, useState } from "react"
import { Button, ErrorNotice } from "../../components/index.ts"
import { apiMutation, apiRequest } from "../../lib/api.ts"
import { errorMessage } from "../../lib/format.ts"

const control = "min-w-0 rounded border border-border bg-background px-2 py-1.5 text-xs"
type Inventory = { ids: string[]; nextCursor?: string }
type Page = ArtifactPage & { ref: ArtifactRef }

function SavedItems({
  url,
  label,
  selected,
  onSelect,
  disabled,
}: {
  url: string
  label: string
  selected: string
  onSelect: (id: string) => void
  disabled: boolean
}) {
  const [cursor, setCursor] = useState("")
  const [page, setPage] = useState<Inventory>({ ids: [] })
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    setError("")
    setPage({ ids: [] })
    void apiRequest<Inventory>(url + (cursor ? "?cursor=" + cursor : ""), {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setPage(data)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      })
    return () => controller.abort()
  }, [url, cursor, selected])
  const ids = selected && !page.ids.includes(selected) ? [selected, ...page.ids] : page.ids
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label>
        {label}{" "}
        <select
          className={control}
          value={selected}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">请选择</option>
          {ids.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
      </label>
      {cursor && (
        <Button variant="ghost" size="sm" onClick={() => setCursor("")}>
          回到首批
        </Button>
      )}
      {page.nextCursor && (
        <Button variant="ghost" size="sm" onClick={() => setCursor(page.nextCursor!)}>
          更多{label}
        </Button>
      )}
      {error && <ErrorNotice message={error} />}
    </div>
  )
}

export function RunEvidencePanel({ url, paths }: { url: string; paths: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mt-4 rounded-md border border-border p-3 text-sm"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">本次 Run 的文件快照与实验记录</summary>
      {open && <EvidenceForm url={url} paths={paths} />}
    </details>
  )
}

function EvidenceForm({ url, paths }: { url: string; paths: string[] }) {
  const pathList = useId()
  const [path, setPath] = useState("")
  const [prefix, setPrefix] = useState("")
  const [selected, setSelected] = useState("")
  const [page, setPage] = useState<Page | null>(null)
  const [encoding, setEncoding] = useState<ArtifactPage["encoding"]>("base64")
  const [offset, setOffset] = useState("0")
  const [note, setNote] = useState("")
  const [experiment, setExperiment] = useState<ExperimentRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const files = url + "/artifacts"
  const experiments = url + "/experiments"
  async function act(action: () => Promise<void>) {
    setError("")
    setFeedback("")
    setBusy(true)
    try {
      await action()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  async function read(id: string, at: string, format = encoding) {
    const q = new URLSearchParams({ offset: at, encoding: format })
    setPage(await apiRequest<Page>(`${files}/${id}/content?${q}`))
    setOffset(at)
  }
  function select(id: string) {
    setSelected(id)
    setPage(null)
    setOffset("0")
    if (id) void act(() => read(id, "0"))
  }
  return (
    <div className="mt-3 grid gap-4 text-xs">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            const ref = await apiMutation<ArtifactRef>(files, "POST", {
              path,
              ...(prefix !== "" ? { prefixBytes: Number(prefix) } : {}),
            })
            setSelected(ref.refId)
            setPage(null)
            setOffset("0")
            setEncoding("base64")
            await read(ref.refId, "0", "base64")
            setFeedback("已保存快照")
          })
        }}
      >
        <label className="grid flex-1 gap-1">
          工作区文件路径
          <input
            className={control}
            required
            list={pathList}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <datalist id={pathList}>
          {paths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <label className="grid gap-1">
          前缀字节数（留空保存全文）
          <input
            className={control}
            type="number"
            min="0"
            step="1"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </label>
        <Button size="sm" type="submit" disabled={busy || !path}>
          保存快照
        </Button>
      </form>
      <SavedItems
        url={files}
        label="文件快照"
        selected={selected}
        onSelect={select}
        disabled={busy}
      />
      {selected && (
        <div className="grid gap-2">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void act(() => read(selected, offset))
            }}
          >
            <label>
              编码{" "}
              <select
                className={control}
                disabled={busy}
                value={encoding}
                onChange={(e) => {
                  const format = e.target.value === "base64" ? "base64" : "utf8"
                  setEncoding(format)
                  setPage(null)
                  void act(() => read(selected, offset, format))
                }}
              >
                <option value="base64">Base64</option>
                <option value="utf8">UTF-8</option>
              </select>
            </label>
            <label>
              字节偏移{" "}
              <input
                className={control}
                type="number"
                min="0"
                step="1"
                required
                value={offset}
                onChange={(e) => setOffset(e.target.value)}
              />
            </label>
            <Button size="sm" variant="outline" disabled={busy} type="submit">
              读取范围
            </Button>
            {page?.hasMore && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => read(selected, String(page.nextOffset)))}
              >
                下一页
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await apiMutation(files + "/" + selected + "/verify", "POST")
                  setFeedback("完整 SHA-256 校验通过")
                })
              }
            >
              校验完整快照
            </Button>
          </form>
          {page && (
            <>
              <div className="break-all">
                {page.ref.path} · {page.ref.state === "final" ? "完整文件" : "固定前缀"} ·{" "}
                {page.byteLength} 字节 · SHA-256 <code>{page.ref.sha256}</code>
              </div>
              <div>
                偏移 {page.offset} 至 {page.nextOffset}（结束位置不含在内）
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2">
                {page.content}
              </pre>
            </>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void act(async () => {
                setExperiment(
                  await apiMutation<ExperimentRecord>(experiments, "POST", {
                    inputRefs: [selected],
                    status: "unknown",
                    note,
                  }),
                )
                setNote("")
                setFeedback("已登记人工实验记录")
              })
            }}
          >
            <label className="grid flex-1 gap-1">
              实验备注
              <input
                className={control}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              以此快照登记实验
            </Button>
          </form>
        </div>
      )}
      <SavedItems
        url={experiments}
        label="实验记录"
        selected={experiment?.id ?? ""}
        disabled={busy}
        onSelect={(id) => {
          setExperiment(null)
          if (id)
            void act(async () =>
              setExperiment(await apiRequest<ExperimentRecord>(experiments + "/" + id)),
            )
        }}
      />
      {experiment && (
        <div>
          <p>
            {experiment.recordedAt} · 人工登记 · {experiment.status}
            {experiment.exitCode !== null && ` · exit ${experiment.exitCode}`}
          </p>
          {experiment.note && <p className="whitespace-pre-wrap break-words">{experiment.note}</p>}
          <details>
            <summary className="cursor-pointer">查看完整实验记录</summary>
            <pre className="max-h-60 overflow-auto">{JSON.stringify(experiment, null, 2)}</pre>
          </details>
        </div>
      )}
      {error && <ErrorNotice message={error} />}
      {feedback && <p role="status">{feedback}</p>}
    </div>
  )
}
