import type { SessionManager } from "@earendil-works/pi-coding-agent"
import type { ExecutionOutcome, ExecutionReport } from "./execution-report.ts"

const MARKER = "ctf_subagent_execution"

/** Host metadata only: Pi custom entries have no model-context projector. */
export function markSubagentExecution(session: SessionManager, executionId: string): string {
  return session.appendCustomEntry(MARKER, { executionId })
}

/** Freeze the leaf and follow original parent links; context summaries are never reports. */
export function collectSubagentReport(
  session: Pick<SessionManager, "getLeafId" | "getEntry">,
  executionId: string,
  outcome: ExecutionOutcome,
): ExecutionReport {
  let id = session.getLeafId()
  const visited = new Set<string>()
  let selected: ExecutionReport | undefined
  while (id) {
    if (visited.has(id)) return unavailable("cycle in session parent chain")
    visited.add(id)
    const entry = session.getEntry(id)
    if (!entry) return unavailable("missing session parent")
    if (entry.type === "custom" && entry.customType === MARKER) {
      if ((entry.data as { executionId?: string } | undefined)?.executionId !== executionId) {
        return unavailable("encountered a different execution marker")
      }
      return selected ?? { available: false, reason: "no_report" }
    }
    if (!selected && entry.type === "message") {
      const message = entry.message
      if (
        message.role === "assistant" ||
        (outcome !== "completed" && message.role === "toolResult")
      ) {
        const text = message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
        if (text.trim() && text.trim() !== "(no output)") {
          selected = {
            available: true,
            kind:
              message.role === "toolResult"
                ? "tool_partial"
                : outcome === "completed"
                  ? "assistant_final"
                  : "assistant_partial",
            text,
          }
        }
      }
    }
    id = entry.parentId
  }
  return unavailable("execution marker missing")
}

function unavailable(detail: string): ExecutionReport {
  return { available: false, reason: "boundary_unavailable", detail }
}
