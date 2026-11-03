import { type ExecutionEnv, getOrThrow } from "@ctf-agent/sandbox"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { type Static, Type } from "typebox"
import { withFileMutationQueue } from "./file-mutation-queue.ts"
import { resolveToolPath } from "./path-utils.ts"

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
})

export function createWriteTool(env: ExecutionEnv): AgentTool<typeof writeSchema, undefined> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    async execute(_toolCallId, params: Static<typeof writeSchema>, signal) {
      const { path, content } = params
      const absolutePath = await resolveToolPath(env, path, signal)
      return withFileMutationQueue(env, absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted")
        getOrThrow(await env.writeFile(absolutePath, content, signal))
        if (signal?.aborted) throw new Error("Operation aborted")
        return {
          content: [
            { type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
          ],
          details: undefined,
        }
      })
    },
  }
}
