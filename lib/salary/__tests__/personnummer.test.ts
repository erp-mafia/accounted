import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  validatePersonnummer,
  extractLast4,
  extractBirthDate,
  calculateAge,
  calculateAgeAtYearStart,
  maskPersonnummer,
  formatPersonnummer,
  expandPersonnummerTo12,
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
    // Luhn-valid on purpose, so this proves the day check is what rejects it
    // rather than the checksum incidentally failing first.
    const result = validatePersonnummer('199001329805')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('dag')
  })

  it('strips non-digits before validation', () => {
    const result = validatePersonnummer('19900101-9802')
    expect(result.valid).toBe(true)
  })

  // A samordningsnummer is a personnummer whose day field carries an added 60,
  // so the printed day is 61-91. Skatteverket files these under FK215 in the
  // arbetsgivardeklaration exactly like a personnummer, and our AGI generator
  // accepts them, so the employee validator has to accept them too. All values
  // below are synthetic and genuinely check-digit valid.
  describe('samordningsnummer', () => {
    it('accepts day 61 (the 1st, offset by 60)', () => {
      expect(validatePersonnummer('199001619809').valid).toBe(true)
    })

    it('accepts day 91 (the 31st, offset by 60)', () => {
      expect(validatePersonnummer('199001919803').valid).toBe(true)
    })

    it('still enforces the Luhn checksum on the offset form', () => {
      // Same samordningsnummer as above with the check digit bumped: the +60
      // offset must not become a way to skip the checksum.
      const result = validatePersonnummer('199001619808')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Luhn')
    })

    it('rejects days 32-60, which are neither a day nor an offset day', () => {
      // Both Luhn-valid, so only the day range can be rejecting them.
      expect(validatePersonnummer('199001329805').valid).toBe(false)
      expect(validatePersonnummer('199001609800').valid).toBe(false)
    })

    it('rejects days 92-99, which offset back to day 32-39', () => {
      expect(validatePersonnummer('199001929802').valid).toBe(false)
      expect(validatePersonnummer('199001999805').valid).toBe(false)
    })
  })
})

/**
 * Read Skatteverket's IDENTITET pattern out of the AGI generator source at test
 * time. The const is module-private, so lifting the literal from the file is
 * deliberate: a copy pasted into this file would keep passing after the
 * generator changed, and that drift is the exact thing this test exists to
 * catch. If the const is renamed or reshaped, this throws instead of silently
 * testing nothing.
 */
function loadIdentitetPattern(): RegExp {
  const generatorPath = fileURLToPath(new URL('../agi/xml-generator.ts', import.meta.url))
  const source = readFileSync(generatorPath, 'utf8')
  const match = source.match(/\bconst IDENTITET_PATTERN = \/(.+)\/\r?\n/)
  if (!match) {
    throw new Error(
      'Could not read IDENTITET_PATTERN from lib/salary/agi/xml-generator.ts. ' +
        'If it moved or was renamed, fix this loader rather than inlining a copy of ' +
        'the pattern: reading the generator is the point of this test.',
    )
  }
  return new RegExp(match[1])
}

/**
 * Append the Luhn check digit to an 11-digit YYYYMMDDNNN prefix. Used only to
 * neutralise the checksum, so that in the sweep below the day rule is the only
 * thing that can decide a case. Pinned to the hand-verified constants above so
 * it cannot quietly drift into agreeing with a broken validator.
 */
function withCheckDigit(prefix11: string): string {
  for (let c = 0; c <= 9; c++) {
    const candidate = `${prefix11}${c}`
    const luhnDigits = candidate.slice(2)
    let sum = 0
    for (let i = 0; i < luhnDigits.length; i++) {
      let d = parseInt(luhnDigits[i], 10)
      if (i % 2 === 0) {
        d *= 2
        if (d > 9) d -= 9
      }
      sum += d
    }
    if (sum % 10 === 0) return candidate
  }
  throw new Error(`No Luhn check digit exists for ${prefix11}`)
}

/**
 * The employee validator and the AGI generator have to agree about who counts
 * as a person. If the validator is stricter, we refuse to register an employee
 * we would happily file an arbetsgivardeklaration for (that was the
 * samordningsnummer bug). If it is looser, we accept an employee whose AGI
 * Skatteverket will later reject, weeks after payroll ran.
 */
describe('agreement with the AGI generator IDENTITET pattern', () => {
  const IDENTITET_PATTERN = loadIdentitetPattern()

  it('reads a working pattern out of the generator source', () => {
    expect(IDENTITET_PATTERN.test('199001019802')).toBe(true)
    expect(IDENTITET_PATTERN.test('199001329805')).toBe(false)
  })

  it('builds sweep fixtures with a genuinely valid check digit', () => {
    expect(withCheckDigit('19900101980')).toBe('199001019802')
    expect(withCheckDigit('19900161980')).toBe('199001619809')
  })

  // Skatteverket's pattern additionally allows day 60: an otherwise ordinary
  // identity number whose day of month is unknown (day 00, offset by 60).
  // Registering such a person as an employee has never been supported here and
  // is out of scope for the samordningsnummer fix, so the divergence is
  // asserted rather than hidden: whichever side moves, this fails loudly.
  const KNOWN_PATTERN_ONLY_DAYS = [60]

  it('accepts exactly the days the generator accepts, for a 31-day month', () => {
    const patternOnly: number[] = []
    const validatorOnly: number[] = []

    for (let day = 0; day <= 99; day++) {
      const pnr = withCheckDigit(`199001${String(day).padStart(2, '0')}980`)
      const patternAccepts = IDENTITET_PATTERN.test(pnr)
      const validatorAccepts = validatePersonnummer(pnr).valid
      if (patternAccepts && !validatorAccepts) patternOnly.push(day)
      if (validatorAccepts && !patternAccepts) validatorOnly.push(day)
    }

    // Generator says yes, we say no: an employee we refuse to register but
    // would file for. Before the fix this listed every samordningsnummer day,
    // 61 through 91.
    expect(patternOnly).toEqual(KNOWN_PATTERN_ONLY_DAYS)
    // We say yes, generator says no: an employee whose AGI is rejected later.
    expect(validatorOnly).toEqual([])
  })

  it('does not accept the unknown-birth-date forms the generator allows', () => {
    const unknownDay = withCheckDigit('19900160980')
    const unknownDate = withCheckDigit('19900065980')

    expect(IDENTITET_PATTERN.test(unknownDay)).toBe(true)
    expect(IDENTITET_PATTERN.test(unknownDate)).toBe(true)
    expect(validatePersonnummer(unknownDay).valid).toBe(false)
    expect(validatePersonnummer(unknownDate).valid).toBe(false)
  })

  it('is looser than the generator for short months, both offset and not', () => {
    // Pre-existing and unchanged by the samordningsnummer fix: the day check is
    // a plain 1-31 range, so it lets April 31 and February 30 through while the
    // generator applies real calendar lengths. That is why the sweep above uses
    // January. Recorded here so nobody reads the sweep as proving more than it
    // does.
    const april31 = withCheckDigit('19900431980')
    const april91 = withCheckDigit('19900491980')

    expect(validatePersonnummer(april31).valid).toBe(true)
    expect(validatePersonnummer(april91).valid).toBe(true)
    expect(IDENTITET_PATTERN.test(april31)).toBe(false)
    expect(IDENTITET_PATTERN.test(april91)).toBe(false)
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

  it('normalizes the samordningsnummer day offset to the real calendar day', () => {
    // Day 61 = the 1st + 60, day 91 = the 31st + 60. The offset is a numbering
    // convention on the printed digits, not a calendar fact: consumers doing
    // date math must see 1-31, never 61-91. Same synthetic, Luhn-valid
    // samordningsnummer as the validatePersonnummer suite above.
    expect(extractBirthDate('199001619809')).toEqual({ year: 1990, month: 1, day: 1 })
    expect(extractBirthDate('199001919803')).toEqual({ year: 1990, month: 1, day: 31 })
  })

  it('leaves ordinary days 1-31 untouched', () => {
    expect(extractBirthDate('199006159802').day).toBe(15)
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

  it('computes samordningsnummer age from the real calendar day', () => {
    // 199001619809 is born 1990-01-01 (printed day 61 = 1 + 60). Comparing the
    // reference day against the OFFSET day made `refDay < birth.day` true for
    // every day of the birth month, shaving a year off the age until the month
    // was over: born-on-the-1st read as 35 on their own 36th birthday.
    expect(calculateAge('199001619809', '2026-01-01')).toBe(36)
    expect(calculateAge('199001619809', '2025-12-31')).toBe(35)
    // End of the offset range too: 1990-01-31 (printed day 91).
    expect(calculateAge('199001919803', '2026-01-30')).toBe(35)
    expect(calculateAge('199001919803', '2026-01-31')).toBe(36)
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

describe('expandPersonnummerTo12', () => {
  // Fixed clock (2026-08-17) so century inference is deterministic.
  const now = new Date(2026, 7, 17)

  it('passes a 12-digit value through with the separator stripped', () => {
    expect(expandPersonnummerTo12('19900101-9802', now)).toBe('199001019802')
    expect(expandPersonnummerTo12('199001019802', now)).toBe('199001019802')
  })

  it('expands a 10-digit value to the most recent past century', () => {
    expect(expandPersonnummerTo12('900101-9802', now)).toBe('199001019802')
    expect(expandPersonnummerTo12('9001019802', now)).toBe('199001019802')
  })

  it('keeps a birth date earlier this century in the 2000s', () => {
    expect(expandPersonnummerTo12('250101-0025', now)).toBe('202501010025')
  })

  it('treats a birth date equal to today as this century', () => {
    expect(expandPersonnummerTo12('260817-0000', now)).toBe('202608170000')
  })

  it('rolls a not-yet-reached date this century back to the 1900s', () => {
    expect(expandPersonnummerTo12('261231-0000', now)).toBe('192612310000')
  })

  it('subtracts a further century for the over-100 plus separator', () => {
    expect(expandPersonnummerTo12('900101+9802', now)).toBe('189001019802')
  })

  it('strips the samordningsnummer day offset for the comparison only', () => {
    // Day 77 = real day 17 (today): this century. Day 78 = real day 18
    // (tomorrow): last century. The returned digits keep the printed day.
    expect(expandPersonnummerTo12('260877-0000', now)).toBe('202608770000')
    expect(expandPersonnummerTo12('260878-0000', now)).toBe('192608780000')
  })

  it('returns null for shapes that are neither 10 nor 12 digits', () => {
    expect(expandPersonnummerTo12('', now)).toBeNull()
    expect(expandPersonnummerTo12('123', now)).toBeNull()
    expect(expandPersonnummerTo12('********-9802', now)).toBeNull()
  })
})
