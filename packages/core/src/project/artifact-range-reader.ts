import { createHash } from "node:crypto"
import type { FileHandle } from "node:fs/promises"

export class EvidenceError extends Error {
  constructor(
    readonly code:
      | "invalid_query"
      | "invalid_offset"
      | "invalid_encoding"
      | "artifact_not_found"
      | "artifact_changed"
      | "artifact_storage_limit"
      | "evidence_unavailable",
    message: string,
  ) {
    super(message)
    this.name = "EvidenceError"
  }
}

export interface ArtifactRangeQuery {
  offset?: number
  limitBytes?: number
  encoding?: "base64" | "utf8"
}

export interface ArtifactPage {
  offset: number
  nextOffset: number
  byteLength: number
  hasMore: boolean
  encoding: "base64" | "utf8"
  content: string
}

/** A short read is legal. EOF before the advertised prefix ends is a change. */
async function readBytes(file: FileHandle, buffer: Buffer, length: number, position: number) {
  let read = 0
  while (read < length) {
    const { bytesRead } = await file.read(buffer, read, length - read, position + read)
    if (!bytesRead)
      throw new EvidenceError("artifact_changed", "File ended before the recorded byte length")
    read += bytesRead
  }
}

export async function hashFilePrefix(
  file: FileHandle,
  length: number,
  copyTo?: FileHandle,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(Math.min(length, 64 * 1024))
  const hash = createHash("sha256")
  for (let position = 0; position < length;) {
    const count = Math.min(length - position, buffer.length)
    await readBytes(file, buffer, count, position)
    const bytes = buffer.subarray(0, count)
    hash.update(bytes)
    if (copyTo) await copyTo.writeFile(bytes)
    position += count
  }
  return hash.digest("hex")
}

export async function readArtifactRange(
  file: FileHandle,
  byteLength: number,
  query: ArtifactRangeQuery = {},
): Promise<ArtifactPage> {
  const { offset, limitBytes, encoding } = validatedRange(byteLength, query)
  const bytes = Buffer.allocUnsafe(Math.min(byteLength - offset, limitBytes))
  await readBytes(file, bytes, bytes.length, offset)
  return encodePage(bytes, byteLength, offset, encoding)
}

/** For an already bounded and immutable snapshot of stored bytes. */
export function readBufferArtifactRange(
  bytes: Buffer,
  query: ArtifactRangeQuery = {},
): ArtifactPage {
  const { offset, limitBytes, encoding } = validatedRange(bytes.length, query)
  return encodePage(bytes.subarray(offset, offset + limitBytes), bytes.length, offset, encoding)
}

function validatedRange(byteLength: number, query: ArtifactRangeQuery) {
  const { offset = 0, limitBytes = 8192, encoding = "base64" } = query
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > byteLength)
    throw new EvidenceError("invalid_offset", "Offset is outside the recorded file")
  if (
    !Number.isSafeInteger(limitBytes) ||
    limitBytes < 1 ||
    limitBytes > 32768 ||
    (encoding !== "base64" && encoding !== "utf8")
  )
    throw new EvidenceError("invalid_query", "Expected 1–32768 bytes and base64 or utf8 encoding")
  return { offset, limitBytes, encoding }
}

function encodePage(
  bytes: Buffer,
  byteLength: number,
  offset: number,
  encoding: ArtifactPage["encoding"],
): ArtifactPage {
  let content: string
  let consumed = bytes.length
  if (encoding === "base64") {
    content = bytes.toString("base64")
  } else {
    try {
      // Keep a BOM as a real code point. Only an incomplete trailing sequence
      // can move to the next page, and only when the file has more bytes.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
        stream: offset + bytes.length < byteLength,
      })
    } catch {
      throw new EvidenceError(
        "invalid_encoding",
        "Invalid UTF-8 at this offset. Read the bytes as base64.",
      )
    }
    consumed = Buffer.byteLength(content, "utf8")
    if (bytes.length && !consumed)
      throw new EvidenceError(
        "invalid_encoding",
        "A complete code point does not fit. Increase limitBytes or request base64.",
      )
  }
  const nextOffset = offset + consumed
  return { encoding, content, byteLength, offset, nextOffset, hasMore: nextOffset < byteLength }
}
