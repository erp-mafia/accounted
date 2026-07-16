import { describe, it, expect } from 'vitest'
import {
  validatePersonnummer,
  extractLast4,
  extractBirthDate,
  calculateAge,
  calculateAgeAtYearStart,
  maskPersonnummer,
  formatPersonnummer,
  encryptPersonnummer,
  decryptPersonnummer,
} from '../personnummer'

describe('validatePersonnummer', () => {
  it('accepts valid 12-digit personnummer', () => {
    // Valid test personnummer (checksum matches)
    const result = validatePersonnummer('199001019802')
    expect(result.valid).toBe(true)
  })

  it('rejects non-12-digit input', () => {
    const result = validatePersonnummer('9001019802')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('12 siffror')
  })

  it('rejects invalid month', () => {
    const result = validatePersonnummer('199013019802')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('månad')
  })

  it('rejects invalid day', () => {
    const result = validatePersonnummer('199001329802')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('dag')
  })

  it('strips non-digits before validation', () => {
    const result = validatePersonnummer('19900101-9802')
    expect(result.valid).toBe(true)
  })
})

describe('extractLast4', () => {
  it('extracts last 4 digits', () => {
    expect(extractLast4('199001019802')).toBe('9802')
  })

  it('handles dash-formatted input', () => {
    expect(extractLast4('19900101-9802')).toBe('9802')
  })
})

describe('extractBirthDate', () => {
  it('extracts birth date from 12-digit personnummer', () => {
    const result = extractBirthDate('199001019802')
    expect(result.year).toBe(1990)
    expect(result.month).toBe(1)
    expect(result.day).toBe(1)
  })
})

describe('calculateAge', () => {
  it('calculates age at a given date', () => {
    expect(calculateAge('199001019802', '2026-04-14')).toBe(36)
  })

  it('returns age minus one before birthday', () => {
    expect(calculateAge('199006159802', '2026-06-14')).toBe(35)
    expect(calculateAge('199006159802', '2026-06-15')).toBe(36)
  })
})

describe('calculateAgeAtYearStart', () => {
  // Skatteverket applies "vid årets ingång fyllt X" rules as birth-year
  // ranges, so the age is the one attained by December 31 of the prior year.
  it('is birth-year based: same birth year means same year-start age', () => {
    expect(calculateAgeAtYearStart('199006159802', 2026)).toBe(35)
    expect(calculateAgeAtYearStart('199012319802', 2026)).toBe(35)
  })

  it('does not count a January 1 birthday as attained at årets ingång', () => {
    // The 2026 youth cohort is born 2003-2007: born 2003-01-01 must read
    // as 22 (eligible) and born 2008-01-01 as 17 (not eligible).
    expect(calculateAgeAtYearStart('199001019802', 2026)).toBe(35)
    expect(calculateAgeAtYearStart('200301011234', 2026)).toBe(22)
    expect(calculateAgeAtYearStart('200801011234', 2026)).toBe(17)
  })
})

describe('maskPersonnummer', () => {
  it('shows birthdate and masks the 4-digit suffix', () => {
    expect(maskPersonnummer('199001019802')).toBe('19900101-XXXX')
  })

  it('strips non-digits before masking', () => {
    expect(maskPersonnummer('19900101-9802')).toBe('19900101-XXXX')
  })
})

describe('formatPersonnummer', () => {
  it('formats with dash', () => {
    expect(formatPersonnummer('199001019802')).toBe('19900101-9802')
  })
})

describe('encryption roundtrip', () => {
  it('encrypts and decrypts correctly', () => {
    const pnr = '199001019802'
    const encrypted = encryptPersonnummer(pnr)
    expect(encrypted).not.toBe(pnr)
    expect(encrypted.length).toBeGreaterThan(pnr.length)

    const decrypted = decryptPersonnummer(encrypted)
    expect(decrypted).toBe(pnr)
  })

  it('produces different ciphertexts for same input (random IV)', () => {
    const pnr = '199001019802'
    const a = encryptPersonnummer(pnr)
    const b = encryptPersonnummer(pnr)
    expect(a).not.toBe(b)
  })
})

describe('decryptPersonnummer tolerance for unencrypted rows', () => {
  it('passes a raw 12-digit personnummer through unchanged (no crash)', () => {
    // A row stored unencrypted (pre-fix v1 create, or a seed) would otherwise
    // be sliced as iv/ciphertext/tag and throw ERR_CRYPTO_INVALID_AUTH_TAG
    // ("Invalid authentication tag length: 6"), 500-ing the whole roster.
    expect(decryptPersonnummer('190001010000')).toBe('190001010000')
  })

  it('still decrypts genuine ciphertext', () => {
    const enc = encryptPersonnummer('199001019802')
    expect(decryptPersonnummer(enc)).toBe('199001019802')
  })
})
