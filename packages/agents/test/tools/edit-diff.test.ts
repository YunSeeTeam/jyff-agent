import { describe, expect, it } from "vite-plus/test"
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "../../src/tools/edit-diff.ts"

describe("edit tool replacements", () => {
  it("applies several exact edits against the original content", () => {
    const { newContent } = applyEditsToNormalizedContent(
      "alpha\nbeta\ngamma\n",
      [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ],
      "file.txt",
    )
    expect(newContent).toBe("ALPHA\nbeta\nGAMMA\n")
  })

  it("matches smart quotes fuzzily and keeps untouched lines byte-for-byte", () => {
    const original = "keep \u201Cquoted\u201D  \nprint(\u2018x\u2019)\n"
    const { newContent } = applyEditsToNormalizedContent(
      original,
      [{ oldText: "print('x')", newText: "print('y')" }],
      "file.py",
    )
    expect(newContent).toBe("keep \u201Cquoted\u201D  \nprint('y')\n")
  })

  it("rejects ambiguous, overlapping, and no-op edits", () => {
    expect(() =>
      applyEditsToNormalizedContent("x\nx\n", [{ oldText: "x", newText: "y" }], "f"),
    ).toThrow("Found 2 occurrences")
    expect(() =>
      applyEditsToNormalizedContent(
        "abcdef",
        [
          { oldText: "abcd", newText: "1" },
          { oldText: "cdef", newText: "2" },
        ],
        "f",
      ),
    ).toThrow("overlap")
    expect(() =>
      applyEditsToNormalizedContent("same", [{ oldText: "same", newText: "same" }], "f"),
    ).toThrow("No changes made")
  })

  it("round-trips BOM and CRLF line endings", () => {
    const { bom, text } = stripBom("\uFEFFa\r\nb\r\n")
    expect(bom).toBe("\uFEFF")
    const ending = detectLineEnding(text)
    expect(ending).toBe("\r\n")
    const { newContent } = applyEditsToNormalizedContent(
      normalizeToLF(text),
      [{ oldText: "b", newText: "c" }],
      "f",
    )
    expect(bom + restoreLineEndings(newContent, ending)).toBe("\uFEFFa\r\nc\r\n")
  })
})
