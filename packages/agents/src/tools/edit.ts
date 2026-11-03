import type { ExecutionEnv, FileError } from "@ctf-agent/sandbox"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import { generateDiffString, generateUnifiedPatch } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type TextEdit,
} from "./edit-diff.ts"
import { withFileMutationQueue } from "./file-mutation-queue.ts"
import { resolveToolPath } from "./path-utils.ts"

const replaceEditSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Type.String({ description: "Replacement text for this targeted edit." }),
})

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(replaceEditSchema, {
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
  }),
})

type EditInput = Static<typeof editSchema>

export interface EditToolDetails {
  diff: string
  patch: string
  firstChangedLine: number | undefined
}

/** Accept edits sent as a JSON string or as one legacy top-level oldText/newText pair. */
function prepareEditArguments(input: unknown): EditInput {
  if (!input || typeof input !== "object") return input as EditInput
  const args = input as Record<string, unknown>
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
    } catch {
      // Leave the value for schema validation to reject.
    }
  }
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
    return args as EditInput
  }
  const edits = Array.isArray(args.edits) ? [...(args.edits as TextEdit[])] : []
  edits.push({ oldText: args.oldText, newText: args.newText })
  const { oldText: _oldText, newText: _newText, ...rest } = args
  return { ...rest, edits } as EditInput
}

function validateEditInput(input: EditInput): { path: string; edits: TextEdit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.")
  }
  return { path: input.path, edits: input.edits }
}

function editAccessError(path: string, error: FileError): Error {
  return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error })
}

export function createEditTool(env: ExecutionEnv): AgentTool<typeof editSchema, EditToolDetails> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editSchema,
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, input: EditInput, signal) {
      const { path, edits } = validateEditInput(input)
      const absolutePath = await resolveToolPath(env, path, signal)
      return withFileMutationQueue(env, absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted")
        const info = await env.fileInfo(absolutePath, signal)
        if (!info.ok) throw editAccessError(path, info.error)
        if (info.value.kind !== "file" && info.value.kind !== "symlink") {
          throw new Error(`Could not edit file: ${path}. Path is not a file.`)
        }
        const read = await env.readTextFile(absolutePath, signal)
        if (!read.ok) throw editAccessError(path, read.error)
        if (signal?.aborted) throw new Error("Operation aborted")
        const { bom, text: content } = stripBom(read.value)
        const originalEnding = detectLineEnding(content)
        const { baseContent, newContent } = applyEditsToNormalizedContent(
          normalizeToLF(content),
          edits,
          path,
        )
        if (signal?.aborted) throw new Error("Operation aborted")
        const written = await env.writeFile(
          absolutePath,
          bom + restoreLineEndings(newContent, originalEnding),
          signal,
        )
        if (!written.ok) throw editAccessError(path, written.error)
        if (signal?.aborted) throw new Error("Operation aborted")
        const diff = generateDiffString(baseContent, newContent)
        return {
          content: [
            { type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` },
          ],
          details: {
            diff: diff.diff,
            patch: generateUnifiedPatch(path, baseContent, newContent),
            firstChangedLine: diff.firstChangedLine,
          },
        }
      })
    },
  }
}
