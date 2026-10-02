/**
 * Decode literal JSON unicode escapes in tools/call string arguments.
 *
 * An agent occasionally double-escapes non-ASCII text while writing the JSON
 * for a tool call: it sends the six characters `\u00f6` where it meant `ö`.
 * Once parsed, the argument is a string that literally contains a backslash
 * and "u00f6", which the tools stored verbatim as verifikat text. On a posted
 * entry that text is then only changeable through a logged rättelse, and not
 * at all once the year is closed, so the escape must never reach storage.
 *
 * No bookkeeping text legitimately contains a backslash followed by "u" and
 * four hex digits, so every tool gets the same rule at the single dispatch
 * point instead of each free-text field growing its own cleanup. Deliberately
 * narrow, so real backslashes survive:
 * - only well-formed `\uXXXX` is decoded; `C:\users`, `\n` and a bare `\u`
 *   are left alone;
 * - an escaped backslash (`\\u00f6`, an even run of backslashes before the
 *   "u") is left alone, so JSON text carried inside a string stays valid;
 * - code points whose decoding would change the meaning of embedded JSON or
 *   break storage (the quote, the backslash, control characters other than
 *   tab/newline/carriage return, lone surrogates) are left alone;
 * - fields that carry a file verbatim (SIE text, beslutsfil JSON, XML) are
 *   never touched.
 */

const VERBATIM_KEYS = new Set(['file_content', 'file_content_base64', 'xml'])

// A run of backslashes, then "u" and four hex digits. Only an odd run is an
// escape: an even run is literal backslashes followed by the text "u...".
const ESCAPE_RE = /(\\+)u([0-9a-fA-F]{4})/g

function isDecodableUnit(code: number): boolean {
  if (code === 0x22 || code === 0x5c) return false
  if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d
  return code !== 0x7f
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

export function decodeLiteralUnicodeEscapes(value: string): string {
  if (!value.includes('\\u')) return value

  // First collect every real escape, then decide per escape, so a surrogate
  // pair is only decoded when both halves are present and adjacent.
  type Escape = { start: number; end: number; prefix: string; code: number }
  const escapes: Escape[] = []
  for (const m of value.matchAll(ESCAPE_RE)) {
    const run = m[1]
    if (run.length % 2 === 0) continue
    escapes.push({
      start: m.index,
      end: m.index + m[0].length,
      prefix: run.slice(0, -1),
      code: parseInt(m[2], 16),
    })
  }
  if (escapes.length === 0) return value

  let out = ''
  let cursor = 0
  for (let i = 0; i < escapes.length; i++) {
    const esc = escapes[i]
    let decoded: string | null = null
    let consumedNext = false
    if (isHighSurrogate(esc.code)) {
      const next = escapes[i + 1]
      if (next && next.start === esc.end && next.prefix === '' && isLowSurrogate(next.code)) {
        decoded = String.fromCharCode(esc.code, next.code)
        consumedNext = true
      }
    } else if (!isLowSurrogate(esc.code) && isDecodableUnit(esc.code)) {
      decoded = String.fromCharCode(esc.code)
    }
    if (decoded === null) continue
    const end = consumedNext ? escapes[i + 1].end : esc.end
    out += value.slice(cursor, esc.start) + esc.prefix + decoded
    cursor = end
    if (consumedNext) i++
  }
  return out + value.slice(cursor)
}

/**
 * Deep-decode every string in a tools/call argument object. Returns the same
 * reference when nothing changed, so the common case allocates nothing.
 */
export function decodeToolArgs<T>(value: T, key?: string): T {
  if (key !== undefined && VERBATIM_KEYS.has(key)) return value
  if (typeof value === 'string') {
    return decodeLiteralUnicodeEscapes(value) as T
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = decodeToolArgs(item)
      if (next !== item) changed = true
      return next
    })
    return (changed ? out : value) as T
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = decodeToolArgs(v, k)
      if (next !== v) changed = true
      out[k] = next
    }
    return (changed ? out : value) as T
  }
  return value
}
