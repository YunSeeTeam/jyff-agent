/**
 * Length, slicing, and paging helpers shared by every bounded output.
 *
 * Text limits count Unicode code points so a page boundary never splits a
 * surrogate pair; byte limits measure the UTF-8 encoding of the value that is
 * actually serialized, not an estimate of the content alone.
 */

const encoder = new TextEncoder()

/** Number of Unicode code points (not UTF-16 units) in `text`. */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count++
  return count
}

/** UTF-16 index where code point number `codePoints` starts, or `text.length` past the end. */
function codeUnitIndex(text: string, codePoints: number): number {
  if (codePoints <= 0) return 0
  let seen = 0
  let index = 0
  while (index < text.length) {
    if (seen === codePoints) return index
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1
    seen++
  }
  return text.length
}

/** Slice by code points: `limit` code points starting at code point `offset`. */
export function sliceCodePoints(text: string, offset: number, limit?: number): string {
  const start = codeUnitIndex(text, Math.max(0, offset))
  if (limit === undefined) return text.slice(start)
  const rest = text.slice(start)
  return rest.slice(0, codeUnitIndex(rest, Math.max(0, limit)))
}

/** The first `maxCodePoints` code points and whether anything was cut. */
export function codePointPrefix(
  text: string,
  maxCodePoints: number,
): { text: string; truncated: boolean } {
  const end = codeUnitIndex(text, Math.max(0, maxCodePoints))
  return { text: text.slice(0, end), truncated: end < text.length }
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** Bytes of `JSON.stringify(value)` in UTF-8: what a tool result or HTTP body really carries. */
export function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value) ?? "")
}

export interface PrefixPage<T> {
  /** The longest contiguous prefix whose rendered form fits the budget. */
  items: T[]
  /** Items after the prefix; they must stay discoverable through a cursor. */
  omittedCount: number
  /** True when even the first item does not fit: the caller must report it, not page forever. */
  firstItemTooLarge: boolean
}

/**
 * Take the longest contiguous prefix of `items` whose rendered page fits
 * `maxBytes`. Pages never skip an item to fit a later, smaller one, so a
 * cursor after the last returned item enumerates everything.
 *
 * `render` builds the complete serialized value for a candidate page, envelope
 * included. Lists here are bounded by their own `limit`, so measuring each
 * candidate is cheap.
 */
export function fitContiguousPrefix<T>(
  items: readonly T[],
  maxBytes: number,
  render: (page: readonly T[]) => unknown,
): PrefixPage<T> {
  let fitting = 0
  while (
    fitting < items.length &&
    jsonByteLength(render(items.slice(0, fitting + 1))) <= maxBytes
  ) {
    fitting++
  }
  return {
    items: items.slice(0, fitting),
    omittedCount: items.length - fitting,
    firstItemTooLarge: items.length > 0 && fitting === 0,
  }
}
