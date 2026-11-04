import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiMutation, apiRequest, projectApi } from "../lib/api.ts"
import { errorMessage } from "../lib/format.ts"
import type {
  ChallengeDetails,
  DashboardRun,
  DashboardSubagent,
  SubagentListPageDto,
} from "../types.ts"
import { useSse } from "./useSse.ts"

export type ConversationTarget =
  | { type: "solver" }
  | {
      type: "subagent"
      subagent: DashboardSubagent
    }

/**
 * 题目工作区的状态逻辑：详情加载、SSE 自动刷新、
 * 派发/终止、选中的 Attempt 与 SubAgent。
 */
export function useChallengeDetails(
  projectId: string,
  challengeId: string,
): {
  details: ChallengeDetails | null
  error: string
  busy: boolean
  selectedRun: DashboardRun | undefined
  selectedSubagent: DashboardSubagent | undefined
  target: ConversationTarget
  selectRun: (runId: string) => void
  selectSubagent: (subagentId: string | null) => void
  /** Load the SubAgents past a Run's first page; they then refresh with every reload. */
  loadMoreSubagents: (runId: string) => Promise<void>
  challengeAction: (action: "dispatch" | "cancel", options?: { force?: boolean }) => Promise<void>
  resetChallenge: () => Promise<void>
  reload: () => Promise<void>
} {
  const [details, setDetails] = useState<ChallengeDetails | null>(null)
  const [selectedRunId, setSelectedRunId] = useState("")
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [extraSubagents, setExtraSubagents] = useState<Record<string, DashboardSubagent[]>>({})
  // Runs whose full SubAgent list the user asked for; only these fetch more pages.
  const expandedRuns = useRef(new Set<string>())

  const remainingSubagents = useCallback(
    async (run: DashboardRun): Promise<DashboardSubagent[]> => {
      const items: DashboardSubagent[] = []
      let cursor = run.subagentsNextCursor
      // Every page holds at least one SubAgent, so the count bounds the loop.
      for (let pages = 0; cursor && pages <= run.subagentCount; pages++) {
        const page = await apiRequest<SubagentListPageDto>(
          projectApi(
            projectId,
            `/api/runs/${encodeURIComponent(run.id)}/subagents?limit=32&cursor=${encodeURIComponent(cursor)}`,
          ),
        )
        items.push(...page.items.map((item) => ({ ...item, hasConversation: hasActivity(item) })))
        cursor = page.nextCursor
      }
      return items
    },
    [projectId],
  )

  const load = useCallback(async (): Promise<void> => {
    const next = await apiRequest<ChallengeDetails>(
      projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}`),
    )
    setDetails(next)
    setSelectedRunId((current) =>
      next.runs.some((run) => run.id === current) ? current : (next.runs[0]?.id ?? ""),
    )
    const expanded = next.runs.filter((run) => expandedRuns.current.has(run.id))
    if (expanded.length === 0) return
    const loaded = await Promise.all(
      expanded.map(async (run) => [run.id, await remainingSubagents(run)] as const),
    )
    setExtraSubagents(Object.fromEntries(loaded))
  }, [challengeId, projectId, remainingSubagents])

  const loadMoreSubagents = useCallback(
    async (runId: string): Promise<void> => {
      const run = details?.runs.find((candidate) => candidate.id === runId)
      if (!run) return
      expandedRuns.current.add(runId)
      try {
        const items = await remainingSubagents(run)
        setExtraSubagents((current) => ({ ...current, [runId]: items }))
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    [details, remainingSubagents],
  )

  const merged = useMemo((): ChallengeDetails | null => {
    if (!details) return null
    return {
      ...details,
      runs: details.runs.map((run) => {
        const extra = extraSubagents[run.id]
        if (!extra) return run
        const { subagentsNextCursor: _loaded, ...rest } = run
        const shown = new Set(run.subagents.map((subagent) => subagent.id))
        return {
          ...rest,
          subagents: [...run.subagents, ...extra.filter((subagent) => !shown.has(subagent.id))],
        }
      }),
    }
  }, [details, extraSubagents])

  useEffect(() => {
    setDetails(null)
    setError("")
    void load().catch((cause) => setError(errorMessage(cause)))
  }, [load])

  useSse(projectApi(projectId, "/api/events"), {
    snapshot: () => {
      void load().catch((cause) => setError(errorMessage(cause)))
    },
  })

  const selectRun = useCallback((runId: string): void => {
    setSelectedRunId(runId)
    setSelectedSubagentId(null)
  }, [])

  const selectSubagent = useCallback(
    (subagentId: string | null): void => setSelectedSubagentId(subagentId),
    [],
  )

  const selectedRun = useMemo(
    () => merged?.runs.find((run) => run.id === selectedRunId) ?? merged?.runs[0],
    [merged, selectedRunId],
  )
  const selectedSubagent = useMemo(
    () => selectedRun?.subagents.find((subagent) => subagent.id === selectedSubagentId),
    [selectedRun, selectedSubagentId],
  )
  const target: ConversationTarget = selectedSubagent
    ? { type: "subagent", subagent: selectedSubagent }
    : { type: "solver" }

  const challengeAction = useCallback(
    async (action: "dispatch" | "cancel", options: { force?: boolean } = {}): Promise<void> => {
      setBusy(true)
      setError("")
      try {
        const force =
          action === "dispatch" &&
          (options.force === true || details?.challenge.status === "blocked")
        await apiMutation(
          projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/${action}`),
          "POST",
          force ? { force: true } : {},
        )
        await load()
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setBusy(false)
      }
    },
    [challengeId, details?.challenge.status, load, projectId],
  )

  const resetChallenge = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError("")
    try {
      await apiMutation(
        projectApi(projectId, `/api/challenges/${encodeURIComponent(challengeId)}/reset`),
        "POST",
        {},
      )
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [challengeId, load, projectId])

  return {
    details: merged,
    error,
    busy,
    selectedRun,
    selectedSubagent,
    target,
    selectRun,
    selectSubagent,
    loadMoreSubagents,
    challengeAction,
    resetChallenge,
    reload: load,
  }
}

/** Same rule as the backend: a SubAgent with any recorded activity has a conversation to open. */
function hasActivity(summary: Omit<DashboardSubagent, "hasConversation">): boolean {
  return (
    summary.usage.turns > 0 ||
    summary.usage.toolUses > 0 ||
    summary.usage.totalTokens > 0 ||
    (summary.totalLength ?? 0) > 0
  )
}
