/**
 * Stable error contract for tools and new HTTP endpoints (design 14.3).
 * `code` is the machine contract, `message` is for people, and `retryable` and
 * `nextAction` tell the caller what to do instead of guessing from text.
 */
export type ToolErrorCode =
  | "invalid_query"
  | "invalid_offset"
  | "result_pending"
  | "result_unavailable"
  | "result_changed"
  | "execution_changed"
  | "result_boundary_unavailable"
  | "report_persistence_failed"
  | "report_storage_limit"
  | "stale_execution"
  | "accepted_persistence_failed"
  | "configuration_dependency_error"
  | "skill_snapshot_unavailable"
  | "skill_snapshot_changed"
  | "unsupported_mode"
  | "capability_unavailable"
  | "request_key_conflict"
  | "resource_limit"
  | "output_limit"
  | "delivery_unknown"
  | "artifact_changed"
  | "invalid_encoding"
  | "entry_too_large"

export interface ToolErrorEnvelope {
  error: {
    code: ToolErrorCode
    message: string
    retryable: boolean
    nextAction: string
    /** Bounded identifiers or counts only; never full report text or command output. */
    details?: Record<string, string | number | boolean | null>
  }
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  options: {
    retryable: boolean
    nextAction: string
    details?: Record<string, string | number | boolean | null>
  },
): ToolErrorEnvelope {
  return {
    error: {
      code,
      message,
      retryable: options.retryable,
      nextAction: options.nextAction,
      ...(options.details ? { details: { ...options.details } } : {}),
    },
  }
}

export function isToolErrorEnvelope(value: unknown): value is ToolErrorEnvelope {
  if (typeof value !== "object" || value === null) return false
  const error = (value as { error?: unknown }).error
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  )
}
