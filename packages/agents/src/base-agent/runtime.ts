import { Agent, type AgentTool } from "@earendil-works/pi-agent-core"
import { InMemoryCredentialStore, type Models } from "@earendil-works/pi-ai"
import {
  AgentSession,
  convertToLlm,
  createExtensionRuntime,
  createSyntheticSourceInfo,
  DEFAULT_COMPACTION_SETTINGS,
  ModelRuntime,
  type ResourceLoader,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent"
import type { OpenedAgentSession } from "./session.ts"
import type { AgentSkill } from "./skills.ts"

/**
 * One ModelRuntime per jyff model registry. AgentSession consults it only to
 * confirm a provider is configured; every request still goes through the
 * registry's own providers via the agent's stream function.
 */
const modelRuntimes = new WeakMap<Models, Promise<ModelRuntime>>()

async function modelRuntimeFor(models: Models): Promise<ModelRuntime> {
  let pending = modelRuntimes.get(models)
  if (!pending) {
    pending = ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    modelRuntimes.set(models, pending)
  }
  const runtime = await pending
  // Providers can be replaced when the model pool is reconfigured.
  for (const provider of models.getProviders()) {
    if (runtime.getRegisteredNativeProvider(provider.id) !== provider) {
      runtime.registerNativeProvider(provider)
    }
  }
  return runtime
}

export function piSkills(skills: readonly AgentSkill[]): Skill[] {
  return skills.map((skill) => {
    const filePath = skill.sandboxPath ?? skill.filePath
    return {
      name: skill.name,
      description: skill.description,
      filePath,
      baseDir: skill.sandboxBaseDir ?? skill.baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "jyff" }),
      disableModelInvocation: skill.disableModelInvocation ?? false,
    }
  })
}

/** Resources come only from jyff: no context files, extensions, prompts, or themes. */
function staticResourceLoader(systemPrompt: string, skills: Skill[]): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}

/**
 * Recent context kept verbatim by a compaction. Pi keeps 20k tokens, which on a
 * small context window can exceed everything above the reserve; Pi then refuses
 * to compact, so the kept tail is capped at half of the usable window.
 */
export function compactionKeepRecentTokens(contextWindow: number): number {
  const usable = contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens
  return Math.min(
    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    Math.max(1_000, Math.floor(usable / 2)),
  )
}

export interface CreatePiSessionOptions {
  opened: OpenedAgentSession
  models: Models
  systemPrompt: string
  /** Directory the model works in, shown in the prompt; a container path for sandboxed agents. */
  workingDirectory: string
  tools: readonly AgentTool[]
  skills: readonly AgentSkill[]
}

/**
 * Build Pi's AgentSession around jyff's model registry and tools.
 *
 * Automatic compaction and retry stay off: Core supervises context pressure and
 * classifies transient failures itself, so Pi must not compact or re-send a
 * request behind its back.
 */
export async function createPiSession(options: CreatePiSessionOptions): Promise<AgentSession> {
  const { opened, models } = options
  const sessionManager = opened.sessionManager
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: opened.model,
      thinkingLevel: opened.thinkingLevel,
      tools: [],
      messages: opened.messages,
    },
    convertToLlm,
    streamFn: (model, context, streamOptions) => models.streamSimple(model, context, streamOptions),
    sessionId: sessionManager.getSessionId(),
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  })
  return new AgentSession({
    agent,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: false,
        keepRecentTokens: compactionKeepRecentTokens(opened.model.contextWindow),
      },
      retry: { enabled: false },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    }),
    cwd: options.workingDirectory,
    resourceLoader: staticResourceLoader(options.systemPrompt, piSkills(options.skills)),
    modelRuntime: await modelRuntimeFor(models),
    baseToolsOverride: Object.fromEntries(options.tools.map((tool) => [tool.name, tool])),
    initialActiveToolNames: opened.activeToolNames,
  })
}
