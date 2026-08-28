import { describe, it, expect } from 'vitest'
import { formatPdfKronor } from '../pdf-format'

// Build the special characters from code points so the assertions cannot be
// corrupted by editor/encoding round-trips: U+00A0 is the sv-SE thousands
// separator, U+2212 is the locale minus that WinAnsi Helvetica cannot render.
const NBSP = String.fromCharCode(0x00a0)
const U2212 = String.fromCharCode(0x2212)

describe('formatPdfKronor', () => {
  it('formats a loss with an ASCII hyphen-minus, never U+2212', () => {
    const out = formatPdfKronor(-4684.24)
    expect(out).toBe(`-4${NBSP}684`)
    expect(out).not.toContain(U2212)
  })

  it('keeps sv-SE thousands grouping for positive amounts', () => {
    expect(formatPdfKronor(1234567.89)).toBe(`1${NBSP}234${NBSP}568`)
  })

  it('rounds to whole kronor and never renders "-0"', () => {
    expect(formatPdfKronor(-0.4)).toBe('0')
    expect(formatPdfKronor(-0.6)).toBe('-1')
    expect(formatPdfKronor(0)).toBe('0')
  })

  it('always uses ASCII hyphen for negative amounts', () => {
    for (const n of [-1, -999, -1000, -4684.24, -1_000_000.5]) {
      const out = formatPdfKronor(n)
      expect(out).not.toContain(U2212)
      expect(out.startsWith('-')).toBe(true)
    }
  })
})
