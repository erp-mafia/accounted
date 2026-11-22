import { describe, it, expect } from 'vitest'
import {
  normalizeOrgNumber,
  orgNumberKey,
  registrationNumberKey,
  sameRegistration,
  isValidOrgNumber,
  isOrgNumberShaped,
  hasInvalidOrgNumberCheckDigit,
  stripOrgNumberFormatting,
  formatOrgNumberDisplay,
  toRedovisare12,
  sameOrgNumber,
  partyOrgKey,
  swedishNumberKind,
  isLegalPersonOrgNumber,
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

describe('the one reducer', () => {
  it('normalizeOrgNumber accepts what orgNumberKey reads, and no 12-digit value without a century', () => {
    expect(normalizeOrgNumber(`83${AB_10}`)).toBeNull()
    expect(orgNumberKey(`83${AB_10}`)).toBeNull()
    expect(isOrgNumberShaped(`83${AB_10}`)).toBe(false)
    expect(hasInvalidOrgNumberCheckDigit(`83${AB_10}`)).toBe(false)
    expect(formatOrgNumberDisplay(`83${AB_10}`)).toBe(`83${AB_10}`)
  })

  it('takes a plus only where a personnummer has it', () => {
    expect(stripOrgNumberFormatting('250175+0112')).toBe('2501750112')
    expect(stripOrgNumberFormatting('+46701234567')).toBe('+46701234567')
    expect(orgNumberKey('+4670123456')).toBeNull()
  })
})

describe('sameOrgNumber', () => {
  it.each([
    ['556012-5790', AB_10],
    ['165560125790', AB_10],
    ['16556012-5790', '556012 5790'],
    ['198003740118', '800374-0118'],
    ['BE0123456789', 'be 0123456789'],
  ])('%s and %s are one number', (a, b) => {
    expect(sameOrgNumber(a, b)).toBe(true)
  })

  it.each([
    ['BE0123456789', 'FR0123456789'],
    ['NO123456789', 'DK123456789'],
    [`83${AB_10}`, AB_10],
    [AB_10, '5560125791'],
    [null, null],
    ['', ''],
    [AB_10, null],
  ])('%s and %s are not', (a, b) => {
    expect(sameOrgNumber(a, b)).toBe(false)
  })
})

describe('partyOrgKey', () => {
  it('is the 10-digit key of a Swedish number and the letters and digits of any other', () => {
    expect(partyOrgKey('165560125790')).toBe(AB_10)
    expect(partyOrgKey('be 0123.456.789')).toBe('BE0123456789')
    expect(partyOrgKey(`83${AB_10}`)).toBe(`83${AB_10}`)
  })

  it('is null when there is no number at all', () => {
    expect(partyOrgKey(null)).toBeNull()
    expect(partyOrgKey('')).toBeNull()
    expect(partyOrgKey(' - ')).toBeNull()
  })
})

describe('swedishNumberKind', () => {
  it.each([
    [AB_10, 'legal_person'],
    ['556012-5790', 'legal_person'],
    ['165560125790', 'legal_person'],
    ['16556012-5790', 'legal_person'],
    ['8003740118', 'person'],
    ['800374-0118', 'person'],
    ['800374+0118', 'person'],
    ['198003740118', 'person'],
    ['19800374-0118', 'person'],
    ['188003740118', 'person'],
    ['208003740118', 'person'],
    // A century that belongs to the other kind of number.
    ['168003740118', 'none'],
    ['195560125790', 'none'],
    // Month 00, month 13, day 00, day 32.
    ['8000011230', 'none'],
    ['8013011237', 'none'],
    ['8001001236', 'none'],
    ['8001321234', 'none'],
    // A VAT number typed as an org number, a foreign number, nothing.
    ['556012579001', 'none'],
    ['BE5560125790', 'none'],
    ['12345', 'none'],
    ['', 'none'],
    [null, 'none'],
    [undefined, 'none'],
  ])('%s is %s', (raw, kind) => {
    expect(swedishNumberKind(raw)).toBe(kind)
  })

  it('needs no check digit: a mistyped personnummer is still a person', () => {
    expect(swedishNumberKind('8003740119')).toBe('person')
  })

  it('isLegalPersonOrgNumber reads the same test', () => {
    expect(isLegalPersonOrgNumber('165560125790')).toBe(true)
    expect(isLegalPersonOrgNumber('BE5560125790')).toBe(false)
    expect(isLegalPersonOrgNumber('8003740118')).toBe(false)
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

describe('orgNumberKey', () => {
  it('reduces every spelling of the same identity to 10 digits', () => {
    expect(orgNumberKey(AB_10)).toBe(AB_10)
    expect(orgNumberKey('556012-5790')).toBe(AB_10)
    expect(orgNumberKey('556012 5790')).toBe(AB_10)
    expect(orgNumberKey('165560125790')).toBe(AB_10)
    expect(orgNumberKey('16556012-5790')).toBe(AB_10)
    expect(orgNumberKey(' 556012 - 5790 ')).toBe(AB_10)
    expect(orgNumberKey('19800101-1231')).toBe(EF_10)
    expect(orgNumberKey('198001011231')).toBe(EF_10)
  })

  it('keeps a VAT number typed into the org field out of the key space', () => {
    // 556012579001 is orgnr + "01"; its last 10 digits are another identity.
    expect(orgNumberKey('556012579001')).toBeNull()
    expect(orgNumberKey('SE556012579001')).toBeNull()
    expect(orgNumberKey('SE 556012-5790 01')).toBeNull()
  })

  it('does not strip letters: a foreign 10-digit registration is not a Swedish number', () => {
    expect(orgNumberKey('BE0123456789')).toBeNull()
    expect(orgNumberKey('SE5560125790')).toBeNull()
  })

  it('does not check the Luhn digit: two rows with the same mistyped number are one supplier', () => {
    expect(orgNumberKey('5560125791')).toBe('5560125791')
    expect(normalizeOrgNumber('5560125791')).toBeNull()
  })

  it('returns null for anything not org-number shaped', () => {
    expect(orgNumberKey('DK12345678')).toBeNull()
    expect(orgNumberKey('12345')).toBeNull()
    expect(orgNumberKey('12345678901')).toBeNull()
    expect(orgNumberKey('')).toBeNull()
    expect(orgNumberKey(null)).toBeNull()
    expect(orgNumberKey(undefined)).toBeNull()
  })
})

describe('registrationNumberKey', () => {
  it('keys a sole trader\'s 16-digit TIC number to the stored personnummer', () => {
    // crm#68: the BankID picker listed the owner's own firm as new because
    // 1982010223430001 was compared raw with the stored 8201022343.
    expect(registrationNumberKey('1982010223430001')).toBe('8201022343')
    expect(registrationNumberKey('2002010112360002')).toBe('0201011236')
  })

  it('keys every other shape exactly as orgNumberKey', () => {
    for (const raw of ['5560125790', '556012-5790', '165560125790', '198001011231', '556012579001', 'BE0123456789', '']) {
      expect(registrationNumberKey(raw)).toBe(orgNumberKey(raw))
    }
  })

  it('does not strip an arbitrary 16-digit number', () => {
    expect(registrationNumberKey('5560125790000001')).toBeNull()
  })

  it('returns null for missing input', () => {
    expect(registrationNumberKey(null)).toBeNull()
    expect(registrationNumberKey(undefined)).toBeNull()
  })
})

describe('sameRegistration', () => {
  it('tells two registrations of one sole trader apart by the serial', () => {
    expect(sameRegistration('2002010112360001', '2002010112360002')).toBe(false)
    expect(sameRegistration('2002010112360002', '2002010112360002')).toBe(true)
    expect(sameRegistration('200201011236 0002', '2002010112360002')).toBe(true)
    // A century apart: two people with the same ten digits.
    expect(sameRegistration('1902010112360001', '2002010112360001')).toBe(false)
  })

  it('does not take a number without the serial for one with it', () => {
    expect(sameRegistration('2002010112360001', '0201011236')).toBe(false)
    expect(sameRegistration('200201011236', '0201011236')).toBe(true)
  })

  it('reads any other number in any written form, as registrationNumberKey does', () => {
    expect(sameRegistration('5560125790', '165560125790')).toBe(true)
    expect(sameRegistration('556012-5790', '5560125790')).toBe(true)
    expect(sameRegistration('5560125790', '5566778899')).toBe(false)
  })

  it('is never true for a side with nothing readable on it', () => {
    expect(sameRegistration(null, null)).toBe(false)
    expect(sameRegistration(undefined, '5560125790')).toBe(false)
    expect(sameRegistration('', '')).toBe(false)
    expect(sameRegistration('BE0123456789', 'BE0123456789')).toBe(false)
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

  it('prefixes 16 for an ideell förening like every other juridisk person', () => {
    // 8-series org numbers are issued by Skatteverket to föreningar; they
    // must never be read as a personnummer century.
    expect(toRedovisare12('814433-4458', 'ideell_forening')).toBe('168144334458')
  })
})
