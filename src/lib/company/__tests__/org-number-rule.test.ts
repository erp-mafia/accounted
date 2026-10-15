import { describe, expect, it } from 'vitest'
import {
  checkNewOrgNumber,
  decideOrgNumberChange,
  lockedOrgNumber,
  validStoredOrgNumber,
} from '../org-number-rule'

// 556012-5790 and 202100-5489: legal persons (third digit 2 or more), valid
// check digit. 121212-1212: Skatteverket's test personnummer, valid check digit.
const AB = '5560125790'
const AB_OTHER = '2021005489'
const PNR = '1212121212'
const AB_BAD_CHECK = '5560125791'

describe('validStoredOrgNumber', () => {
  it('reads a valid number in any stored form as ten digits', () => {
    expect(validStoredOrgNumber('5560125790')).toBe(AB)
    expect(validStoredOrgNumber('556012-5790')).toBe(AB)
    expect(validStoredOrgNumber('16556012-5790')).toBe(AB)
    expect(validStoredOrgNumber('19121212-1212')).toBe(PNR)
  })

  it('is null for empty, unshaped, a VAT number or a wrong check digit', () => {
    expect(validStoredOrgNumber(null)).toBeNull()
    expect(validStoredOrgNumber('')).toBeNull()
    expect(validStoredOrgNumber('saknas')).toBeNull()
    expect(validStoredOrgNumber('12345')).toBeNull()
    expect(validStoredOrgNumber('556012579001')).toBeNull()
    expect(validStoredOrgNumber(AB_BAD_CHECK)).toBeNull()
  })
})

describe('lockedOrgNumber', () => {
  it('is the valid number on either stored copy, the settings copy first', () => {
    expect(lockedOrgNumber(AB, null)).toBe(AB)
    expect(lockedOrgNumber('', AB)).toBe(AB)
    expect(lockedOrgNumber(AB_BAD_CHECK, AB)).toBe(AB)
    expect(lockedOrgNumber(AB, AB_OTHER)).toBe(AB)
    expect(lockedOrgNumber(AB_BAD_CHECK, '')).toBeNull()
    expect(lockedOrgNumber(null, null)).toBeNull()
  })
})

describe('checkNewOrgNumber', () => {
  it('takes a legal person\'s number for an aktiebolag, in 10 or 12 digits, with or without separator', () => {
    expect(checkNewOrgNumber('556012-5790', 'aktiebolag')).toEqual({ ok: true, value: AB })
    expect(checkNewOrgNumber('165560125790', 'aktiebolag')).toEqual({ ok: true, value: AB })
    expect(checkNewOrgNumber('202100-5489', 'ideell_forening')).toEqual({ ok: true, value: AB_OTHER })
    expect(checkNewOrgNumber(AB, 'ekonomisk_forening')).toEqual({ ok: true, value: AB })
  })

  it('takes the owner\'s personnummer for an enskild firma, with or without century', () => {
    expect(checkNewOrgNumber('121212-1212', 'enskild_firma')).toEqual({ ok: true, value: PNR })
    expect(checkNewOrgNumber('19121212-1212', 'enskild_firma')).toEqual({ ok: true, value: PNR })
  })

  it('refuses a wrong check digit and what is no Swedish org number', () => {
    expect(checkNewOrgNumber(AB_BAD_CHECK, 'aktiebolag')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_INVALID' })
    expect(checkNewOrgNumber('1212121213', 'enskild_firma')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_INVALID' })
    expect(checkNewOrgNumber('556012579001', 'aktiebolag')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_INVALID' })
    expect(checkNewOrgNumber('', 'aktiebolag')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_INVALID' })
  })

  it('refuses a number that does not fit the legal form', () => {
    expect(checkNewOrgNumber(PNR, 'aktiebolag')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED' })
    expect(checkNewOrgNumber(PNR, 'ideell_forening')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED' })
    expect(checkNewOrgNumber(AB, 'enskild_firma')).toEqual({ ok: false, code: 'SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED' })
  })

  it('skips the form check when the legal form is unknown', () => {
    expect(checkNewOrgNumber(PNR, null)).toEqual({ ok: true, value: PNR })
    expect(checkNewOrgNumber(AB, undefined)).toEqual({ ok: true, value: AB })
  })
})

describe('decideOrgNumberChange', () => {
  const decide = (incoming: string | null | undefined, storedSettings: string | null, storedCompany: string | null = null, entityType: unknown = 'aktiebolag') =>
    decideOrgNumberChange({ incoming, storedSettings, storedCompany, entityType })

  it('empty: a valid number is filled in, as ten digits', () => {
    expect(decide('556012-5790', null)).toEqual({ kind: 'fill', value: AB })
    expect(decide('556012-5790', '')).toEqual({ kind: 'fill', value: AB })
    expect(decide('19121212-1212', null, null, 'enskild_firma')).toEqual({ kind: 'fill', value: PNR })
  })

  it('valid stored: a different number is refused, the same number in another form is no change', () => {
    expect(decide(AB_OTHER, AB)).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' })
    expect(decide('', AB)).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' })
    expect(decide('165560125790', '556012-5790')).toEqual({ kind: 'unchanged' })
  })

  it('a valid number on the company row locks the field as well', () => {
    expect(decide(AB_OTHER, '', AB)).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' })
    expect(decide(AB, AB_BAD_CHECK, AB)).toEqual({ kind: 'unchanged' })
  })

  it('invalid stored: fixable with a valid number', () => {
    expect(decide(AB, AB_BAD_CHECK)).toEqual({ kind: 'fill', value: AB })
    expect(decide(AB, 'saknas', '12345')).toEqual({ kind: 'fill', value: AB })
  })

  it('a wrong check digit or the wrong form is refused even when nothing is stored', () => {
    expect(decide(AB_BAD_CHECK, null)).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_INVALID' })
    expect(decide(PNR, null)).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LEGAL_ENTITY_REQUIRED' })
    expect(decide(AB, null, null, 'enskild_firma')).toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED' })
  })

  it('the form sending the stored value back is no change, whatever that value is', () => {
    expect(decide(AB_BAD_CHECK, AB_BAD_CHECK)).toEqual({ kind: 'unchanged' })
    expect(decide(' saknas ', 'saknas')).toEqual({ kind: 'unchanged' })
    expect(decide('', null)).toEqual({ kind: 'unchanged' })
    expect(decide(undefined, '')).toEqual({ kind: 'unchanged' })
  })
})
