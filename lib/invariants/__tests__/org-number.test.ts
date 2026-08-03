import { describe, it, expect } from 'vitest'
import {
  normalizeOrgNumber,
  isValidOrgNumber,
  isOrgNumberShaped,
  hasInvalidOrgNumberCheckDigit,
  stripOrgNumberFormatting,
  formatOrgNumberDisplay,
  toRedovisare12,
} from '@/lib/invariants/org-number'

// Real-shaped numbers with correct Luhn check digits.
const AB_10 = '5560125790'
const EF_10 = '8001011231'

describe('stripOrgNumberFormatting', () => {
  it('removes hyphens and spaces, nothing else', () => {
    expect(stripOrgNumberFormatting('556012-5790')).toBe(AB_10)
    expect(stripOrgNumberFormatting('556012 5790')).toBe(AB_10)
    expect(stripOrgNumberFormatting(' 556012 - 5790 ')).toBe(AB_10)
    // Letters are preserved so the caller's shape check can reject them,
    // instead of a digit-strip silently making garbage look valid.
    expect(stripOrgNumberFormatting('5560125790x')).toBe('5560125790x')
  })
})

describe('normalizeOrgNumber', () => {
  it('accepts the forms users actually type', () => {
    expect(normalizeOrgNumber(AB_10)).toBe(AB_10)
    expect(normalizeOrgNumber('556012-5790')).toBe(AB_10)
    expect(normalizeOrgNumber('556012 5790')).toBe(AB_10)
  })

  it('strips the century prefix from the 12-digit form', () => {
    expect(normalizeOrgNumber('165560125790')).toBe(AB_10)
    expect(normalizeOrgNumber('198001011231')).toBe(EF_10)
    expect(normalizeOrgNumber('19800101-1231')).toBe(EF_10)
  })

  it('rejects wrong length, non-digits and a bad check digit', () => {
    expect(normalizeOrgNumber('55601257')).toBeNull()
    expect(normalizeOrgNumber('5560125790x')).toBeNull()
    expect(normalizeOrgNumber('5560125791')).toBeNull() // check digit off by one
    expect(normalizeOrgNumber('')).toBeNull()
    expect(normalizeOrgNumber(null)).toBeNull()
    expect(normalizeOrgNumber(undefined)).toBeNull()
  })
})

describe('shape versus check digit', () => {
  it('separates "wrong format" from "wrong last digit"', () => {
    expect(isOrgNumberShaped('5560125791')).toBe(true)
    expect(isValidOrgNumber('5560125791')).toBe(false)
    expect(hasInvalidOrgNumberCheckDigit('5560125791')).toBe(true)

    // Wrong shape is not a check-digit problem.
    expect(hasInvalidOrgNumberCheckDigit('55601')).toBe(false)
    // A valid number is neither.
    expect(hasInvalidOrgNumberCheckDigit(AB_10)).toBe(false)
  })
})

describe('formatOrgNumberDisplay', () => {
  it('renders NNNNNN-NNNN from any accepted input form', () => {
    expect(formatOrgNumberDisplay(AB_10)).toBe('556012-5790')
    expect(formatOrgNumberDisplay('556012 5790')).toBe('556012-5790')
    expect(formatOrgNumberDisplay('165560125790')).toBe('556012-5790')
  })

  it('passes through anything that is not org-number shaped', () => {
    expect(formatOrgNumberDisplay('nonsense')).toBe('nonsense')
    expect(formatOrgNumberDisplay('')).toBe('')
  })
})

describe('toRedovisare12', () => {
  it('prefixes 16 for aktiebolag', () => {
    expect(toRedovisare12(AB_10, 'aktiebolag')).toBe('165560125790')
    expect(toRedovisare12('556012-5790', 'aktiebolag')).toBe('165560125790')
  })

  it('prefixes the century for enskild firma', () => {
    // 80 is above the current two-digit year, so it belongs to the 1900s.
    expect(toRedovisare12(EF_10, 'enskild_firma')).toBe('198001011231')
  })

  it('passes an already 12-digit value through untouched', () => {
    expect(toRedovisare12('165560125790', 'aktiebolag')).toBe('165560125790')
  })

  it('accepts spaces, which the previous hyphen-only strip did not', () => {
    expect(toRedovisare12('556012 5790', 'aktiebolag')).toBe('165560125790')
  })

  it('throws on a length it cannot interpret', () => {
    expect(() => toRedovisare12('55601', 'aktiebolag')).toThrow(/Ogiltigt organisationsnummer/)
  })

  it('stays permissive about the check digit', () => {
    // Export-time conversion must not start rejecting numbers that are already
    // stored and filing: a failed export at a deadline is worse than letting
    // Skatteverket reject it with its own message. See the module docblock.
    expect(toRedovisare12('5560125791', 'aktiebolag')).toBe('165560125791')
  })
})
