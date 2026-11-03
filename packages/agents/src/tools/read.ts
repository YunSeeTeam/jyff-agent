import { Buffer } from "node:buffer"
import { type ExecutionEnv, getOrThrow } from "@ctf-agent/sandbox"
import type { AgentTool } from "@earendil-works/pi-agent-core"
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { detectSupportedImageMimeType } from "./image.ts"
import { resolveReadToolPath } from "./path-utils.ts"

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
})

export interface ReadToolDetails {
  truncation?: TruncationResult
}

/** Read text and images from the execution environment. */
export function createReadTool(
  env: ExecutionEnv,
): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    async execute(_toolCallId, params: Static<typeof readSchema>, signal) {
      const { path, offset, limit } = params
      const absolutePath = await resolveReadToolPath(env, path, signal)
      const bytes = getOrThrow(await env.readBinaryFile(absolutePath, signal))
      const mimeType = detectSupportedImageMimeType(bytes)
      if (mimeType === "image/bmp") {
        return {
          content: [
            {
              type: "text",
              text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
            },
          ],
          details: undefined,
        }
      }
      if (mimeType) {
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
          ],
          details: undefined,
        }
      }

      const allLines = new TextDecoder().decode(bytes).split("\n")
      const totalFileLines = allLines.length
      const startLine = offset ? Math.max(0, offset - 1) : 0
      const startLineDisplay = startLine + 1
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`)
      }
      let selectedContent: string
      let userLimitedLines: number | undefined
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length)
        selectedContent = allLines.slice(startLine, endLine).join("\n")
        userLimitedLines = endLine - startLine
      } else {
        selectedContent = allLines.slice(startLine).join("\n")
      }
      const truncation = truncateHead(selectedContent)
      let outputText: string
      let details: ReadToolDetails | undefined
      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(
          new TextEncoder().encode(allLines[startLine] ?? "").byteLength,
        )
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`
        details = { truncation }
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1
        const nextOffset = endLineDisplay + 1
        outputText = truncation.content
        outputText +=
          truncation.truncatedBy === "lines"
            ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`
            : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
        details = { truncation }
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines)
        const nextOffset = startLine + userLimitedLines + 1
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
      } else {
        outputText = truncation.content
      }
      return { content: [{ type: "text", text: outputText }], details }
    },
  }
}
