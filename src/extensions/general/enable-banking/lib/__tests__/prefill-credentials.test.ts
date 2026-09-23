import { describe, it, expect } from 'vitest'
import { buildPrefilledCredentials, companyIdDigits, soleTraderPersonnummer12 } from '../prefill-credentials'
import type { AuthMethod } from '../api-client'

// Verbatim shape from GET /aspsps?country=SE&psu_type=business (2026-09-14).
const HANDELSBANKEN_BANKID: AuthMethod = {
  name: 'BANKID',
  title: 'Bank ID',
  approach: 'DECOUPLED',
  hidden_method: true,
  credentials: [
    {
      name: 'userId',
      title: 'User ID',
      required: true,
      description: 'Swedish social security number in the format YYYYMMDDXXXX',
      template: '^(19|20)\\d{2}[01]\\d[0-3]\\d\\d{4}$',
    },
    {
      name: 'companyId',
      title: 'Company ID',
      required: true,
      description:
        'For Swedish Corporates, this is their Organisation number or SHB number, and for Sole Traders (Enskild firma), it is their Personal number, all of which are 10 digits.',
      template: '^\\d{10}$',
    },
  ],
}

// A companyId credential that takes either length, like the one behind
// Nordea's business page ("10 digit organisation number (or 12 digit
// personal number if the company is a sole proprietorship)").
const EITHER_LENGTH: AuthMethod = {
  name: 'BANKID',
  credentials: [{ name: 'companyId', required: true, template: '^(\\d{10}|\\d{12})$' }],
}

const NOW = new Date('2026-09-24T12:00:00Z')

describe('companyIdDigits', () => {
  it('strips the hyphen from an organisationsnummer', () => {
    expect(companyIdDigits({ org_number: '556809-8239', entity_type: 'aktiebolag' })).toBe('5568098239')
    expect(companyIdDigits({ org_number: '5568098239', entity_type: 'aktiebolag' })).toBe('5568098239')
  })

  it('reduces a sole trader personnummer with century to the 10-digit form', () => {
    expect(companyIdDigits({ org_number: '19850101-1234', entity_type: 'enskild_firma' })).toBe('8501011234')
    expect(companyIdDigits({ org_number: '198501011234', entity_type: 'enskild_firma' })).toBe('8501011234')
  })

  it('returns null when the number is missing or not 10 digits', () => {
    expect(companyIdDigits({ org_number: null, entity_type: 'aktiebolag' })).toBeNull()
    expect(companyIdDigits({ org_number: '', entity_type: 'aktiebolag' })).toBeNull()
    expect(companyIdDigits({ org_number: '12345', entity_type: 'aktiebolag' })).toBeNull()
    // Twelve digits on a company is not a personnummer with century.
    expect(companyIdDigits({ org_number: '165568098239', entity_type: 'aktiebolag' })).toBeNull()
  })
})

describe('buildPrefilledCredentials', () => {
  it('prefills companyId for a method that declares it, never the personnummer', () => {
    expect(
      buildPrefilledCredentials(HANDELSBANKEN_BANKID, { org_number: '556809-8239', entity_type: 'aktiebolag' }),
    ).toEqual({ companyId: '5568098239' })
  })

  it('sends nothing when the method declares no companyId credential', () => {
    const swedbank: AuthMethod = { name: 'BANKID', approach: 'DECOUPLED', hidden_method: true }
    expect(buildPrefilledCredentials(swedbank, { org_number: '556809-8239', entity_type: 'aktiebolag' })).toBeUndefined()
    expect(buildPrefilledCredentials(undefined, { org_number: '556809-8239', entity_type: 'aktiebolag' })).toBeUndefined()
  })

  it('sends nothing when the value would fail the page template', () => {
    expect(buildPrefilledCredentials(HANDELSBANKEN_BANKID, { org_number: null, entity_type: 'aktiebolag' })).toBeUndefined()
    expect(buildPrefilledCredentials(HANDELSBANKEN_BANKID, { org_number: '55-68', entity_type: 'aktiebolag' })).toBeUndefined()
  })

  it('treats an unparsable template as no constraint for a company', () => {
    const method: AuthMethod = {
      name: 'X',
      credentials: [{ name: 'companyId', template: '(' }],
    }
    expect(buildPrefilledCredentials(method, { org_number: '5568098239', entity_type: 'aktiebolag' })).toEqual({
      companyId: '5568098239',
    })
  })

  it('sends a company its 10-digit org number even when the template accepts 12', () => {
    expect(
      buildPrefilledCredentials(EITHER_LENGTH, { org_number: '556809-8239', entity_type: 'aktiebolag' }, NOW),
    ).toEqual({ companyId: '5568098239' })
  })
})

describe('soleTraderPersonnummer12', () => {
  it('keeps a personnummer stored with century', () => {
    expect(soleTraderPersonnummer12({ org_number: '19850101-1234', entity_type: 'enskild_firma' }, NOW)).toBe(
      '198501011234',
    )
    expect(soleTraderPersonnummer12({ org_number: '200501011234', entity_type: 'enskild_firma' }, NOW)).toBe(
      '200501011234',
    )
  })

  it('derives the century of a 10-digit personnummer from the current year', () => {
    // 85 is after 26: born 1985. 05 and 26 are not: born 2005 and 2026.
    expect(soleTraderPersonnummer12({ org_number: '850101-1234', entity_type: 'enskild_firma' }, NOW)).toBe(
      '198501011234',
    )
    expect(soleTraderPersonnummer12({ org_number: '0501011234', entity_type: 'enskild_firma' }, NOW)).toBe(
      '200501011234',
    )
    expect(soleTraderPersonnummer12({ org_number: '2601011234', entity_type: 'enskild_firma' }, NOW)).toBe(
      '202601011234',
    )
  })

  it('moves the century back for the "+" separator of a person aged 100 or more', () => {
    expect(soleTraderPersonnummer12({ org_number: '200101+1234', entity_type: 'enskild_firma' }, NOW)).toBe(
      '192001011234',
    )
  })

  it('returns null for a company or an unusable number', () => {
    expect(soleTraderPersonnummer12({ org_number: '556809-8239', entity_type: 'aktiebolag' }, NOW)).toBeNull()
    expect(soleTraderPersonnummer12({ org_number: null, entity_type: 'enskild_firma' }, NOW)).toBeNull()
    expect(soleTraderPersonnummer12({ org_number: '12345', entity_type: 'enskild_firma' }, NOW)).toBeNull()
    expect(soleTraderPersonnummer12({ org_number: '165568098239', entity_type: 'enskild_firma' }, NOW)).toBeNull()
  })
})

describe('buildPrefilledCredentials for a sole trader', () => {
  it('sends the 12-digit personnummer when the template accepts it', () => {
    expect(
      buildPrefilledCredentials(EITHER_LENGTH, { org_number: '19850101-1234', entity_type: 'enskild_firma' }, NOW),
    ).toEqual({ companyId: '198501011234' })
  })

  it('derives the century when the personnummer is stored as 10 digits', () => {
    expect(
      buildPrefilledCredentials(EITHER_LENGTH, { org_number: '850101-1234', entity_type: 'enskild_firma' }, NOW),
    ).toEqual({ companyId: '198501011234' })
  })

  it('falls back to the 10-digit form when only that matches the template', () => {
    expect(
      buildPrefilledCredentials(HANDELSBANKEN_BANKID, { org_number: '19850101-1234', entity_type: 'enskild_firma' }, NOW),
    ).toEqual({ companyId: '8501011234' })
    expect(
      buildPrefilledCredentials(HANDELSBANKEN_BANKID, { org_number: '850101-1234', entity_type: 'enskild_firma' }, NOW),
    ).toEqual({ companyId: '8501011234' })
  })

  it('sends nothing when the method declares no usable template', () => {
    const noTemplate: AuthMethod = { name: 'X', credentials: [{ name: 'companyId' }] }
    const badTemplate: AuthMethod = { name: 'X', credentials: [{ name: 'companyId', template: '(' }] }
    const company = { org_number: '19850101-1234', entity_type: 'enskild_firma' }
    expect(buildPrefilledCredentials(noTemplate, company, NOW)).toBeUndefined()
    expect(buildPrefilledCredentials(badTemplate, company, NOW)).toBeUndefined()
  })

  it('sends nothing when neither form matches the template', () => {
    const eightDigits: AuthMethod = { name: 'X', credentials: [{ name: 'companyId', template: '^\\d{8}$' }] }
    expect(
      buildPrefilledCredentials(eightDigits, { org_number: '19850101-1234', entity_type: 'enskild_firma' }, NOW),
    ).toBeUndefined()
  })
})
