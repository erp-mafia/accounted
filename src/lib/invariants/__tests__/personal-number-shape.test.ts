import { describe, expect, it } from 'vitest'
import {
  isOrgNumberRefusedOnIndividual,
  isPersonalNumberOrgNumberDisallowed,
  looksLikeSwedishPersonalNumber,
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
  orgNumberIsPersonalIdentifier,
  personalNumberDigits,
  vatNumberHoldsPersonalNumber,
} from '@/lib/invariants/personal-number-shape'

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

describe('isPersonalNumberOrgNumberDisallowed', () => {
  it('refuses a personnummer-shaped org_number only on the foreign business types', () => {
    expect(isPersonalNumberOrgNumberDisallowed('eu_business', '19900101-1234')).toBe(true)
    expect(isPersonalNumberOrgNumberDisallowed('non_eu_business', '9001011234')).toBe(true)
  })

  it('accepts one on a Swedish business: an enskild firma has no other org number (#2367)', () => {
    expect(isPersonalNumberOrgNumberDisallowed('swedish_business', '19900101-1234')).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed('swedish_business', '900101-1234')).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed('swedish_business', '19900161-1234')).toBe(false)
  })

  it('never fires on an individual: that value is rerouted, not refused', () => {
    expect(isPersonalNumberOrgNumberDisallowed('individual', '19900101-1234')).toBe(false)
  })

  it('ignores legal-entity org numbers, empty values and unknown types', () => {
    expect(isPersonalNumberOrgNumberDisallowed('eu_business', '556677-8899')).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed('eu_business', '')).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed('eu_business', '   ')).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed('eu_business', null)).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed('eu_business', undefined)).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed(null, '19900101-1234')).toBe(false)
    expect(isPersonalNumberOrgNumberDisallowed(undefined, '19900101-1234')).toBe(false)
  })
})

describe('orgNumberIsPersonalIdentifier', () => {
  it('is true for an enskild firma org number, in every written form', () => {
    expect(orgNumberIsPersonalIdentifier('19900101-1234')).toBe(true)
    expect(orgNumberIsPersonalIdentifier('9001011234')).toBe(true)
    expect(orgNumberIsPersonalIdentifier('900101-1234')).toBe(true)
    // '+' marks someone over a hundred.
    expect(orgNumberIsPersonalIdentifier('900101+1234')).toBe(true)
    // Samordningsnummer: the day is offset by 60.
    expect(orgNumberIsPersonalIdentifier('19900161-1234')).toBe(true)
  })

  it('is true without a valid check digit: a mistyped personnummer is still a person', () => {
    // The Luhn check digit for 900101-123x is 9; a typo there must not unmask it.
    expect(orgNumberIsPersonalIdentifier('900101-1239')).toBe(true)
    expect(orgNumberIsPersonalIdentifier('900101-1235')).toBe(true)
  })

  it('is true whatever row type holds it, legacy foreign-business rows included (#95)', () => {
    // The function no longer asks the customer type: a personnummer filed
    // as eu_business / non_eu_business before the write paths refused it
    // is the same person's number.
    expect(orgNumberIsPersonalIdentifier('199001011234')).toBe(true)
  })

  it('is false for a legal person: the month position is 20 or more', () => {
    expect(orgNumberIsPersonalIdentifier('556677-8899')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('5566778899')).toBe(false)
    // Ideell förening, handelsbolag, and the 16-prefixed 12-digit form.
    expect(orgNumberIsPersonalIdentifier('802481-1658')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('969712-3456')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('165566778899')).toBe(false)
  })

  it('is false for a date that cannot be a birth date and for foreign numbers', () => {
    expect(orgNumberIsPersonalIdentifier('901301-1234')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('900100-1234')).toBe(false)
    // Norway (9 digits), Denmark (8), a Swiss UID.
    expect(orgNumberIsPersonalIdentifier('923609016')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('12345678')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('CHE-123.456.789')).toBe(false)
  })

  it('is false for empty values', () => {
    expect(orgNumberIsPersonalIdentifier('')).toBe(false)
    expect(orgNumberIsPersonalIdentifier('  ')).toBe(false)
    expect(orgNumberIsPersonalIdentifier(null)).toBe(false)
    expect(orgNumberIsPersonalIdentifier(undefined)).toBe(false)
  })
})

describe('vatNumberHoldsPersonalNumber', () => {
  it("is true for an enskild firma's VAT number, which carries the owner's personnummer", () => {
    expect(vatNumberHoldsPersonalNumber('SE900101123401')).toBe(true)
    expect(vatNumberHoldsPersonalNumber('se 900101-1234 01')).toBe(true)
  })

  it("is false for a company's VAT number, a foreign one, and empty values", () => {
    expect(vatNumberHoldsPersonalNumber('SE556677889901')).toBe(false)
    expect(vatNumberHoldsPersonalNumber('DK12345678')).toBe(false)
    // Not the SE...01 shape at all.
    expect(vatNumberHoldsPersonalNumber('SE9001011234')).toBe(false)
    expect(vatNumberHoldsPersonalNumber('')).toBe(false)
    expect(vatNumberHoldsPersonalNumber(null)).toBe(false)
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

describe('isOrgNumberRefusedOnIndividual', () => {
  it('refuses a legal-entity or unrecognised org number on an individual', () => {
    expect(isOrgNumberRefusedOnIndividual('individual', '556677-8899')).toBe(true)
    expect(isOrgNumberRefusedOnIndividual('individual', 'HRB 12345')).toBe(true)
  })

  it('passes a personnummer (rerouted elsewhere), an empty value and every business type', () => {
    expect(isOrgNumberRefusedOnIndividual('individual', '19900101-1234')).toBe(false)
    expect(isOrgNumberRefusedOnIndividual('individual', '')).toBe(false)
    expect(isOrgNumberRefusedOnIndividual('individual', '   ')).toBe(false)
    expect(isOrgNumberRefusedOnIndividual('individual', null)).toBe(false)
    expect(isOrgNumberRefusedOnIndividual('individual', undefined)).toBe(false)
    expect(isOrgNumberRefusedOnIndividual('swedish_business', '556677-8899')).toBe(false)
    expect(isOrgNumberRefusedOnIndividual(undefined, '556677-8899')).toBe(false)
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
