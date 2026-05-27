import { describe, it, expect } from 'vitest'
import { boundToolResultText, MAX_TOOL_RESULT_CHARS } from '../run-turn'

// Tool results re-enter the model context on every later loop iteration and are
// persisted as a 'tool' message that loadConversationMessages replays on every
// future turn. An unbounded read (gnubok_get_document_content returns full
// OCR/PDF text) would therefore re-introduce the context rot we keep out of the
// system prompt. boundToolResultText caps the serialized payload.

describe('boundToolResultText — tool-return discipline', () => {
  it('passes small results through unchanged', () => {
    const small = JSON.stringify({ rows: [{ account: '1930', amount: 1000 }] })
    expect(boundToolResultText(small)).toBe(small)
  })

  it('passes a result exactly at the ceiling through unchanged', () => {
    const exact = 'x'.repeat(MAX_TOOL_RESULT_CHARS)
    expect(boundToolResultText(exact)).toBe(exact)
  })

  it('truncates an oversized result to the ceiling and appends a steer', () => {
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 50_000)
    const out = boundToolResultText(huge)
    // The body is capped at the ceiling…
    expect(out.startsWith('x'.repeat(MAX_TOOL_RESULT_CHARS))).toBe(true)
    expect(out.length).toBeLessThan(huge.length)
    // …and the marker tells the model it was cut and how to narrow.
    expect(out).toContain('avkortat')
    expect(out).toContain(String(huge.length))
    expect(out.toLowerCase()).toMatch(/smalare|limit|datumintervall/)
  })
})
