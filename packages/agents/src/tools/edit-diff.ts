/**
 * Exact and fuzzy text replacement for the edit tool, ported from Pi 0.82's
 * env-agnostic tools (MIT). Display diffs come from pi-coding-agent's exports.
 */

export interface TextEdit {
  oldText: string
  newText: string
}

interface MatchedEdit {
  editIndex: number
  matchIndex: number
  matchLength: number
  newText: string
}

interface FuzzyMatchResult {
  found: boolean
  index: number
  matchLength: number
  usedFuzzyMatch: boolean
  contentForReplacement: string
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n")
  const lfIndex = content.indexOf("\n")
  if (lfIndex === -1 || crlfIndex === -1) return "\n"
  return crlfIndex < lfIndex ? "\r\n" : "\n"
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

/** Strip a UTF-8 BOM if present, returning both the BOM and the remaining text. */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content }
}

/**
 * Normalize text for fuzzy matching: strip trailing whitespace per line and fold
 * smart quotes, Unicode dashes, and special spaces to their ASCII forms.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function getLineSpans(content: string): Array<{ start: number; end: number }> {
  let offset = 0
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

function getReplacementLineRange(
  lines: ReadonlyArray<{ start: number; end: number }>,
  replacement: MatchedEdit,
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex
  const replacementEnd = replacement.matchIndex + replacement.matchLength
  const startLine = lines.findIndex(
    (line) => replacementStart >= line.start && replacementStart < line.end,
  )
  if (startLine === -1) throw new Error("Replacement range is outside the base content.")
  let endLine = startLine
  while (endLine < lines.length && (lines[endLine]?.end ?? 0) < replacementEnd) endLine++
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.")
  return { startLine, endLine: endLine + 1 }
}

function applyReplacements(content: string, replacements: readonly MatchedEdit[], offset = 0) {
  let result = content
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]
    if (!replacement) continue
    const matchIndex = replacement.matchIndex - offset
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

/**
 * Apply replacements matched against a normalized `baseContent` to
 * `originalContent`, copying every untouched line back from the original.
 */
function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: readonly MatchedEdit[],
): string {
  const originalLines = splitLinesWithEndings(originalContent)
  const baseLines = getLineSpans(baseContent)
  if (originalLines.length !== baseLines.length) {
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    )
  }
  const groups: Array<{ startLine: number; endLine: number; replacements: MatchedEdit[] }> = []
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = getReplacementLineRange(baseLines, replacement)
    const current = groups.at(-1)
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
      continue
    }
    groups.push({ ...range, replacements: [replacement] })
  }
  let originalLineIndex = 0
  let result = ""
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("")
    const groupStartOffset = baseLines[group.startLine]?.start ?? 0
    const groupEndOffset = baseLines[group.endLine - 1]?.end ?? groupStartOffset
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    )
    originalLineIndex = group.endLine
  }
  return result + originalLines.slice(originalLineIndex).join("")
}

/** Find `oldText` exactly first, then in fuzzy-normalized space. */
function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText)
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    }
  }
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    }
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  }
}

function countOccurrences(content: string, oldText: string): number {
  return normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1
}

function notFoundError(path: string, editIndex: number, totalEdits: number): Error {
  return totalEdits === 1
    ? new Error(
        `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
      )
    : new Error(
        `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
      )
}

function duplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  return totalEdits === 1
    ? new Error(
        `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
      )
    : new Error(
        `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
      )
}

function emptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  return totalEdits === 1
    ? new Error(`oldText must not be empty in ${path}.`)
    : new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`)
}

function noChangeError(path: string, totalEdits: number): Error {
  return totalEdits === 1
    ? new Error(
        `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
      )
    : new Error(`No changes made to ${path}. The replacements produced identical content.`)
}

/**
 * Apply one or more replacements to LF-normalized content. Every edit is matched
 * against the same original; fuzzy matches are overlaid line by line so
 * unchanged blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly TextEdit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }))
  normalizedEdits.forEach((edit, index) => {
    if (edit.oldText.length === 0) throw emptyOldTextError(path, index, normalizedEdits.length)
  })
  const usedFuzzyMatch = normalizedEdits.some(
    (edit) => fuzzyFindText(normalizedContent, edit.oldText).usedFuzzyMatch,
  )
  const replacementBaseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent
  const matchedEdits: MatchedEdit[] = normalizedEdits.map((edit, index) => {
    const match = fuzzyFindText(replacementBaseContent, edit.oldText)
    if (!match.found) throw notFoundError(path, index, normalizedEdits.length)
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText)
    if (occurrences > 1) throw duplicateError(path, index, normalizedEdits.length, occurrences)
    return {
      editIndex: index,
      matchIndex: match.index,
      matchLength: match.matchLength,
      newText: edit.newText,
    }
  })
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let index = 1; index < matchedEdits.length; index++) {
    const previous = matchedEdits[index - 1]
    const current = matchedEdits[index]
    if (previous && current && previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      )
    }
  }
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(
        normalizedContent,
        replacementBaseContent,
        matchedEdits,
      )
    : applyReplacements(replacementBaseContent, matchedEdits)
  if (normalizedContent === newContent) throw noChangeError(path, normalizedEdits.length)
  return { baseContent: normalizedContent, newContent }
}
