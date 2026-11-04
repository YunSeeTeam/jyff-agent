/**
 * Narrow interface for reading one SubAgent execution's report out of its Pi
 * session (design 7.3). Defined in stage 2 for interface review; the
 * implementation arrives with P1-b. Core consumes it; it never reaches the model.
 */

/** Mirrors `SubagentResultKind` in `@ctf-agent/core/contracts`; a core test pins them together. */
export type ExecutionReportKind = "assistant_final" | "assistant_partial" | "tool_partial"

/** How the execution ended, as recorded by the manager; it decides which text may be selected. */
export type ExecutionOutcome = "completed" | "failed" | "cancelled" | "aborted" | "timed_out"

export type ExecutionReport =
  | { available: true; kind: ExecutionReportKind; text: string }
  | {
      available: false
      /** `boundary_unavailable`: the marker or the parent chain could not be followed. */
      reason: "no_report" | "boundary_unavailable"
      detail?: string
    }

export interface ExecutionReportSource {
  /**
   * Append the non-model-visible marker that starts an execution and return its
   * session entry id. Called after the execution is durably begun, before it runs.
   */
  markExecutionStart(executionId: string): string
  /**
   * Freeze the current leaf and walk raw parent links back to the marker of
   * `executionId`, selecting text from this execution only. Never scans the
   * whole history or uses compaction summaries as original messages.
   */
  collectReport(executionId: string, outcome: ExecutionOutcome): ExecutionReport
}
