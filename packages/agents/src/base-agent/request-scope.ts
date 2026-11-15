import { AsyncLocalStorage } from "node:async_hooks"

export interface ModelRequestEvent {
  requestId: string
  projectId?: string
  challengeId?: string
  runId?: string
  agentId?: string
  executionId?: string
  purpose?: string
  provider: string
  model: string
  state: "queued" | "sending" | "completed" | "failed"
  sent: boolean
  usageKnown: boolean
  reason?: string
}

export interface ModelRequestGuard {
  signal?: AbortSignal
  canSend?: () => boolean
  onEvent?: (event: ModelRequestEvent) => void
}

export interface ModelRequestScope extends ModelRequestGuard {
  projectId?: string
  challengeId?: string
  runId?: string
  agentId?: string
  executionId?: string
  purpose?: string
}

const contexts = new AsyncLocalStorage<Readonly<ModelRequestScope>>()
export const currentModelRequestScope = () => contexts.getStore()

/** Scope belongs to one operation, never mutable global state on a shared provider. */
export function withModelRequestScope<T>(
  scope: ModelRequestScope | undefined,
  operation: () => T,
): T {
  return contexts.run(Object.freeze({ ...contexts.getStore(), ...scope }), operation)
}
