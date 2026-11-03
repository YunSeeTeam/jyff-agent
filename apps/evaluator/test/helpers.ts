import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type AgentMessage, JsonlSessionStorage, Session } from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai"
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux"

const roots: string[] = []

export async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `evaluator-${prefix}-`))
  roots.push(root)
  return root
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

export function usage(tokens: Partial<Omit<Usage, "cost">> & { costTotal?: number }): Usage {
  const input = tokens.input ?? 0
  const output = tokens.output ?? 0
  const cacheRead = tokens.cacheRead ?? 0
  const cacheWrite = tokens.cacheWrite ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens.costTotal ?? 0,
    },
  }
}

export function assistant(
  text: string,
  options: { provider: string; model: string; usage: Usage },
): AssistantMessage {
  return {
    ...fauxAssistantMessage(text),
    provider: options.provider,
    model: options.model,
    usage: options.usage,
  }
}

export function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() }
}

/** Write a real Pi JSONL session at path. */
export async function writeSession(
  path: string,
  build: (session: Session) => Promise<void>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const env = new NodeExecutionEnv({ cwd: dirname(path) })
  const storage = await JsonlSessionStorage.create(env, path, {
    cwd: dirname(path),
    sessionId: "fixture",
  })
  await build(new Session(storage))
}

/** Minimal configured data root whose root Project is projectId. */
export async function writeTemplateRoot(root: string, projectId: string): Promise<void> {
  const state = join(root, ".ctf-agent")
  await mkdir(state, { recursive: true })
  await writeFile(
    join(state, "project-registry.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: projectId,
          directory: ".",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          archived: false,
          activation: { state: "started" },
        },
      ],
    }),
  )
  await writeFile(
    join(state, "project-config.json"),
    JSON.stringify({ project: { id: projectId } }),
  )
  await writeFile(join(state, "secrets.json"), JSON.stringify({ token: "template-secret" }))
}
