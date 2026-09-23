import { describe, it, expect } from 'vitest'
import { buildPrefilledCredentials, companyIdDigits } from '../prefill-credentials'
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

  it('treats an unparsable template as no constraint', () => {
    const method: AuthMethod = {
      name: 'X',
      credentials: [{ name: 'companyId', template: '(' }],
    }
    expect(buildPrefilledCredentials(method, { org_number: '5568098239', entity_type: 'aktiebolag' })).toEqual({
      companyId: '5568098239',
    })
  })
})
