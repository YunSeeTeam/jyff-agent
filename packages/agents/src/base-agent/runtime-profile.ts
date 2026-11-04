import { createRequire } from "node:module"
import { PI_AI_VERSION } from "@earendil-works/pi-ai"
import { CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent"

/**
 * Identifies the agent runtime a Run was created with (design 7.5). A Run must
 * be resumed by an adapter that reads the same session format; it never
 * switches runtime halfway through.
 */
export const AGENT_RUNTIME_ADAPTER_ID = "pi-agent-session-v1"

export interface AgentRuntimeProfile {
  adapterId: string
  /** Installed Pi package versions, read at runtime rather than assumed. */
  packages: Record<string, string>
  sessionFormat: string
}

const require = createRequire(import.meta.url)

export function agentRuntimeProfile(): AgentRuntimeProfile {
  const core = require("@earendil-works/pi-agent-core/package.json") as { version: string }
  return {
    adapterId: AGENT_RUNTIME_ADAPTER_ID,
    packages: {
      "@earendil-works/pi-agent-core": core.version,
      "@earendil-works/pi-ai": PI_AI_VERSION,
      "@earendil-works/pi-coding-agent": VERSION,
    },
    sessionFormat: `pi-session-v${CURRENT_SESSION_VERSION}`,
  }
}

/** Session formats this build can resume. */
export function resumableSessionFormats(): ReadonlySet<string> {
  return new Set([`pi-session-v${CURRENT_SESSION_VERSION}`])
}
