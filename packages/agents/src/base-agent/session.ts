import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core"
import {
  type Api,
  getCurrentTools,
  type Model,
  type Models,
  type SystemMessage,
} from "@earendil-works/pi-ai"
import {
  CURRENT_SESSION_VERSION,
  type SessionEntry,
  type SessionHeader,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import { DEFAULT_SOLVER_THINKING_LEVEL, isThinkingLevel, resolveThinkingLevel } from "./thinking.ts"

export interface NativeSessionOptions {
  path: string
  id: string
  /** Host directory recorded in the session header. */
  cwd: string
  metadata?: Record<string, unknown>
}

export interface OpenAgentSessionOptions {
  session: NativeSessionOptions
  models: Models
  model: Model<Api>
  thinkingLevel?: ThinkingLevel
  tools: readonly AgentTool[]
  activeToolNames?: readonly string[]
  initialMessages?: readonly AgentMessage[]
}

export interface OpenedAgentSession {
  sessionManager: SessionManager
  model: Model<Api>
  thinkingLevel: ThinkingLevel
  activeToolNames: string[]
  /** Model-visible transcript, including the prompt and tool system messages. */
  messages: AgentMessage[]
  restored: boolean
}

/** Raised when a persisted session cannot be resumed with the current configuration. */
export class SessionRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionRestoreError"
  }
}

/** The header carries jyff metadata so a session file identifies its owner without RunStore. */
type JyffSessionHeader = SessionHeader & { metadata?: Record<string, unknown> }

/** Pi 0.82 recorded tool loadouts as their own entry type; keep reading them for old runs. */
interface LegacyActiveToolsEntry {
  type: "active_tools_change"
  activeToolNames: string[]
}

function isLegacyActiveToolsEntry(entry: unknown): entry is LegacyActiveToolsEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === "active_tools_change" &&
    Array.isArray((entry as { activeToolNames?: unknown }).activeToolNames)
  )
}

function restoredThinkingLevel(
  branch: readonly SessionEntry[],
  fallback: ThinkingLevel,
  model: Model<Api>,
): ThinkingLevel {
  let value: string | undefined
  for (const entry of branch) {
    if (entry.type === "thinking_level_change") value = entry.thinkingLevel
  }
  if (value === undefined) return resolveThinkingLevel(model, fallback)
  if (!isThinkingLevel(value)) {
    throw new SessionRestoreError(`Session contains unsupported thinking level: ${value}`)
  }
  return resolveThinkingLevel(model, value)
}

/**
 * Custom entry recording the active tool loadout jyff selected. Pi's system
 * messages only show what was declared to the model by the last request, so a
 * loadout changed or narrowed between requests needs its own record.
 */
export const ACTIVE_TOOLS_ENTRY_TYPE = "jyff.active_tools"

interface ActiveToolsData {
  activeToolNames: string[]
}

function isActiveToolsData(data: unknown): data is ActiveToolsData {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { activeToolNames?: unknown }).activeToolNames)
  )
}

export function recordActiveTools(sessionManager: SessionManager, names: readonly string[]): void {
  sessionManager.appendCustomEntry(ACTIVE_TOOLS_ENTRY_TYPE, {
    activeToolNames: [...names],
  } satisfies ActiveToolsData)
}

/** The latest recorded loadout, falling back to the tools last declared to the model. */
function restoredToolNames(branch: readonly SessionEntry[]): string[] | undefined {
  const systemMessages: SystemMessage[] = []
  let recorded: string[] | undefined
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "system") {
      systemMessages.push(entry.message)
    } else if (entry.type === "custom" && entry.customType === ACTIVE_TOOLS_ENTRY_TYPE) {
      if (isActiveToolsData(entry.data)) recorded = [...entry.data.activeToolNames]
    } else {
      const raw: unknown = entry
      if (isLegacyActiveToolsEntry(raw)) recorded = [...raw.activeToolNames]
    }
  }
  if (recorded) return recorded
  const declares = systemMessages.some(
    (message) => (message.toolsAdded?.length ?? 0) + (message.toolsRemoved?.length ?? 0) > 0,
  )
  return declares ? getCurrentTools(systemMessages).map((tool) => tool.name) : undefined
}

async function createSessionFile(options: OpenAgentSessionOptions): Promise<SessionManager> {
  await mkdir(dirname(options.session.path), { recursive: true })
  const header: JyffSessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: options.session.id,
    timestamp: new Date().toISOString(),
    cwd: options.session.cwd,
    ...(options.session.metadata ? { metadata: options.session.metadata } : {}),
  }
  // Writing the header eagerly fixes the session id and path; Pi otherwise picks
  // a random id and defers the file until the first conversation message.
  await writeFile(options.session.path, `${JSON.stringify(header)}\n`, { flag: "wx" })
  return SessionManager.open(options.session.path)
}

/** Create a Pi JSONL session, or reopen one and restore its persisted runtime settings. */
export async function openAgentSession(
  options: OpenAgentSessionOptions,
): Promise<OpenedAgentSession> {
  const legalToolNames = options.tools.map((tool) => tool.name)
  const defaultToolNames = [...(options.activeToolNames ?? legalToolNames)]

  if (!existsSync(options.session.path)) {
    const thinkingLevel = resolveThinkingLevel(
      options.model,
      options.thinkingLevel ?? DEFAULT_SOLVER_THINKING_LEVEL,
    )
    const sessionManager = await createSessionFile(options)
    for (const message of options.initialMessages ?? []) {
      sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0])
    }
    sessionManager.appendModelChange(options.model.provider, options.model.id)
    sessionManager.appendThinkingLevelChange(thinkingLevel)
    recordActiveTools(sessionManager, defaultToolNames)
    return {
      sessionManager,
      model: options.model,
      thinkingLevel,
      activeToolNames: defaultToolNames,
      messages: sessionManager.buildSessionContext().messages,
      restored: false,
    }
  }

  const sessionManager = SessionManager.open(options.session.path)
  const context = sessionManager.buildSessionContext()
  const model = context.model
    ? options.models.getModel(context.model.provider, context.model.modelId)
    : options.model
  if (!model) {
    throw new SessionRestoreError(
      `Session model is unavailable: ${context.model?.provider}/${context.model?.modelId}`,
    )
  }
  const branch = sessionManager.getBranch()
  // A session may outlive the tools it was created with (role whitelist narrowed,
  // tool removed). Restore only names the current tool set still allows, and record
  // the narrowed set so a later reopen cannot silently re-expand it.
  const legal = new Set(legalToolNames)
  const persisted = restoredToolNames(branch)
  const activeToolNames = (persisted ?? defaultToolNames).filter((name) => legal.has(name))
  if (persisted && activeToolNames.length !== persisted.length) {
    recordActiveTools(sessionManager, activeToolNames)
  }
  return {
    sessionManager,
    model,
    thinkingLevel: restoredThinkingLevel(
      branch,
      options.thinkingLevel ?? DEFAULT_SOLVER_THINKING_LEVEL,
      model,
    ),
    activeToolNames,
    messages: sessionManager.buildSessionContext().messages,
    restored: true,
  }
}
