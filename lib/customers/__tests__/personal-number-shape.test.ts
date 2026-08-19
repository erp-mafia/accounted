import { describe, expect, it } from 'vitest'
import { looksLikeSwedishPersonalNumber } from '@/lib/customers/personal-number-shape'

// Every personal-shaped fixture is synthetic, never a real person's number.
describe('looksLikeSwedishPersonalNumber', () => {
  it('recognizes a 10-digit personnummer with and without separator', () => {
    expect(looksLikeSwedishPersonalNumber('900101-1234')).toBe(true)
    expect(looksLikeSwedishPersonalNumber('9001011234')).toBe(true)
    expect(looksLikeSwedishPersonalNumber('900101+1234')).toBe(true)
  })

  it('recognizes a 12-digit personnummer for all personal centuries', () => {
    expect(looksLikeSwedishPersonalNumber('19900101-1234')).toBe(true)
    expect(looksLikeSwedishPersonalNumber('199001011234')).toBe(true)
    expect(looksLikeSwedishPersonalNumber('200412241234')).toBe(true)
    expect(looksLikeSwedishPersonalNumber('189912311234')).toBe(true)
  })

  it('recognizes a samordningsnummer (day offset by 60)', () => {
    expect(looksLikeSwedishPersonalNumber('19900161-1234')).toBe(true)
    expect(looksLikeSwedishPersonalNumber('900191-1234')).toBe(true)
  })

  it('rejects legal-entity organisationsnummer (month position >= 20)', () => {
    expect(looksLikeSwedishPersonalNumber('556677-8899')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('5566778899')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('212000-0142')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('165566778899')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('16556677-8899')).toBe(false)
  })

  it('rejects values that are neither shape', () => {
    expect(looksLikeSwedishPersonalNumber('')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('SE556677889901')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('12345')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('19901301-1234')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('19900145-1234')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('19900199-1234')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('179001011234')).toBe(false)
    expect(looksLikeSwedishPersonalNumber('************')).toBe(false)
  })
})
