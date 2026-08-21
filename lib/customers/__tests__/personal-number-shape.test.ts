import { describe, expect, it } from 'vitest'
import {
  looksLikeSwedishPersonalNumber,
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
  personalNumberDigits,
} from '@/lib/customers/personal-number-shape'

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

describe('orgNumberHoldsPersonalNumber', () => {
  it('is true only for an individual whose org_number has personnummer shape', () => {
    expect(orgNumberHoldsPersonalNumber('individual', '19900101-1234')).toBe(true)
    expect(orgNumberHoldsPersonalNumber('individual', '9001011234')).toBe(true)
    expect(orgNumberHoldsPersonalNumber('individual', '19900101 1234')).toBe(true)
  })

  it('is false for business types, legal-entity org numbers, and empty values', () => {
    // A business carrying a personnummer is the other guard's job (reject),
    // not a reroute.
    expect(orgNumberHoldsPersonalNumber('swedish_business', '19900101-1234')).toBe(false)
    expect(orgNumberHoldsPersonalNumber('individual', '556677-8899')).toBe(false)
    expect(orgNumberHoldsPersonalNumber('individual', '')).toBe(false)
    expect(orgNumberHoldsPersonalNumber('individual', '   ')).toBe(false)
    expect(orgNumberHoldsPersonalNumber('individual', null)).toBe(false)
    expect(orgNumberHoldsPersonalNumber('individual', undefined)).toBe(false)
    expect(orgNumberHoldsPersonalNumber(undefined, '19900101-1234')).toBe(false)
  })
})

describe('normalizeReroutedPersonalNumber / personalNumberDigits', () => {
  it('drops whitespace but keeps the separator', () => {
    expect(normalizeReroutedPersonalNumber('19900101 1234')).toBe('199001011234')
    expect(normalizeReroutedPersonalNumber(' 19900101-1234 ')).toBe('19900101-1234')
    expect(normalizeReroutedPersonalNumber('900101+1234')).toBe('900101+1234')
  })

  it('compares across written forms by digits only', () => {
    expect(personalNumberDigits('19900101-1234')).toBe('199001011234')
    expect(personalNumberDigits('19900101-1234')).toBe(personalNumberDigits('199001011234'))
    expect(personalNumberDigits('900101-1234')).not.toBe(personalNumberDigits('19900101-1234'))
  })
})
