import { describe, expect, it } from "vite-plus/test"
import {
  codePointLength,
  codePointPrefix,
  fitContiguousPrefix,
  isToolErrorEnvelope,
  jsonByteLength,
  sliceCodePoints,
  toolError,
  utf8ByteLength,
} from "../../src/contracts/index.ts"

// "a" + U+1F600 (surrogate pair) + "中" + "b"
const mixed = `a${String.fromCodePoint(0x1f600)}中b`

describe("code point helpers", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(mixed.length).toBe(5)
    expect(codePointLength(mixed)).toBe(4)
    expect(codePointLength("")).toBe(0)
  })

  it("never splits a surrogate pair when slicing", () => {
    expect(sliceCodePoints(mixed, 0, 2)).toBe(`a${String.fromCodePoint(0x1f600)}`)
    expect(sliceCodePoints(mixed, 1, 1)).toBe(String.fromCodePoint(0x1f600))
    expect(sliceCodePoints(mixed, 2)).toBe("中b")
    expect(sliceCodePoints(mixed, 4)).toBe("")
    expect(sliceCodePoints(mixed, 9, 3)).toBe("")
  })

  it("reports whether a prefix was cut", () => {
    expect(codePointPrefix(mixed, 3)).toEqual({
      text: `a${String.fromCodePoint(0x1f600)}中`,
      truncated: true,
    })
    expect(codePointPrefix(mixed, 4)).toEqual({ text: mixed, truncated: false })
  })

  it("measures the UTF-8 bytes of the serialized value", () => {
    expect(utf8ByteLength(mixed)).toBe(1 + 4 + 3 + 1)
    // JSON escaping counts: a quote becomes two bytes inside the string.
    expect(jsonByteLength({ text: '"' })).toBe('{"text":"\\""}'.length)
  })
})

describe("fitContiguousPrefix", () => {
  const render = (page: readonly string[]) => ({ items: page, nextCursor: "c" })

  it("returns the longest prefix that fits and counts what was left out", () => {
    const items = ["aaaa", "bbbb", "cccc", "dddd"]
    const budget = jsonByteLength(render(items.slice(0, 2)))
    const page = fitContiguousPrefix(items, budget, render)
    expect(page).toEqual({ items: ["aaaa", "bbbb"], omittedCount: 2, firstItemTooLarge: false })
  })

  it("does not skip an item to fit a smaller later one", () => {
    const items = ["a", "x".repeat(100), "b"]
    const budget = jsonByteLength(render(["a", "b"]))
    expect(fitContiguousPrefix(items, budget, render).items).toEqual(["a"])
  })

  it("flags a first item that can never fit instead of returning an empty page silently", () => {
    const page = fitContiguousPrefix(["x".repeat(100)], 20, render)
    expect(page).toEqual({ items: [], omittedCount: 1, firstItemTooLarge: true })
    expect(fitContiguousPrefix([], 20, render).firstItemTooLarge).toBe(false)
  })
})

describe("tool error envelope", () => {
  it("carries a stable code, retryability, and the next action", () => {
    const envelope = toolError("result_changed", "The report changed", {
      retryable: true,
      nextAction: "Read the first page of the current execution again",
      details: { agentId: "a1" },
    })
    expect(envelope).toEqual({
      error: {
        code: "result_changed",
        message: "The report changed",
        retryable: true,
        nextAction: "Read the first page of the current execution again",
        details: { agentId: "a1" },
      },
    })
    expect(isToolErrorEnvelope(envelope)).toBe(true)
    expect(isToolErrorEnvelope({ error: "text" })).toBe(false)
  })
})
