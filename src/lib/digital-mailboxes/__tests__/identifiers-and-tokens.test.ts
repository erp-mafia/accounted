import { describe, expect, it, vi } from 'vitest'
import { DigitalMailboxApiError, createTokenCache, withToken } from '../http'
import {
  isLegalPersonOrgNumber,
  orgNumberFromVatNumber,
  payslipEmployerContact,
  personnummer12,
  phoneToE164,
  swedishVatNumber,
} from '../identifiers'

describe('identifiers', () => {
  it('turns an organisationsnummer into the VAT shape both providers use, and back', () => {
    expect(swedishVatNumber('556016-0680')).toBe('SE556016068001')
    expect(swedishVatNumber('165560160680')).toBe('SE556016068001')
    expect(swedishVatNumber('556016-0681')).toBeNull()
    expect(orgNumberFromVatNumber('SE556016068001')).toBe('5560160680')
    expect(orgNumberFromVatNumber('se 556016068001')).toBe('5560160680')
    expect(orgNumberFromVatNumber('DE123')).toBeNull()
  })

  it('tells a legal person from a sole trader by the third digit', () => {
    expect(isLegalPersonOrgNumber('5560160680')).toBe(true)
    // A personnummer (an enskild firma's organisationsnummer).
    expect(isLegalPersonOrgNumber('8112189876')).toBe(false)
    expect(isLegalPersonOrgNumber(null)).toBe(false)
  })

  it('expands and validates a personnummer to twelve digits', () => {
    expect(personnummer12('811218-9876')).toBe('198112189876')
    expect(personnummer12('198112189876')).toBe('198112189876')
    expect(personnummer12('811218-9875')).toBeNull()
    expect(personnummer12(null)).toBeNull()
  })

  it('normalises Swedish mobile numbers to E.164', () => {
    expect(phoneToE164('070-123 45 67')).toBe('+46701234567')
    expect(phoneToE164('+46 70 123 45 67')).toBe('+46701234567')
    expect(phoneToE164('0046701234567')).toBe('+46701234567')
    expect(phoneToE164('46701234567')).toBe('+46701234567')
    expect(phoneToE164('12')).toBeNull()
    expect(phoneToE164('')).toBeNull()
  })

  it('reads the employer contact a payslip carries, phone in national form, or null while one is missing', () => {
    const employer = {
      name: 'Exempel AB',
      orgNumber: '5560160680',
      streetAddress: ' Storgatan 1 ',
      postalCode: '111 22',
      city: 'Stockholm',
      country: 'SE',
      email: 'lon@exempel.se',
      phone: '08-123 456 78',
    }
    expect(payslipEmployerContact(employer)).toEqual({
      streetAddress: 'Storgatan 1',
      postalCode: '111 22',
      city: 'Stockholm',
      email: 'lon@exempel.se',
      phone: '0812345678',
    })
    expect(payslipEmployerContact({ ...employer, phone: '+44 20 7946 0958' })?.phone).toBe('+442079460958')
    expect(payslipEmployerContact({ ...employer, streetAddress: '  ' })).toBeNull()
    expect(payslipEmployerContact({ ...employer, email: 'inte-en-adress' })).toBeNull()
    expect(payslipEmployerContact({ ...employer, phone: null })).toBeNull()
    expect(payslipEmployerContact({ ...employer, city: null })).toBeNull()
  })
})

describe('token cache', () => {
  it('shares one issuance between concurrent callers and renews before expiry', async () => {
    let now = 0
    const issue = vi.fn(async () => ({ token: `t${issue.mock.calls.length}`, expiresInSeconds: 120 }))
    const cache = createTokenCache(issue, () => now)
    const [a, b] = await Promise.all([cache.get(), cache.get()])
    expect(a).toBe('t1')
    expect(b).toBe('t1')
    expect(issue).toHaveBeenCalledTimes(1)
    now = 30_000
    await expect(cache.get()).resolves.toBe('t1')
    // Within the 60 s margin of the 120 s lifetime: a new token.
    now = 61_000
    await expect(cache.get()).resolves.toBe('t2')
  })

  it('retries a 401 once with a fresh token, and never a 403', async () => {
    const issue = vi.fn(async () => ({ token: `t${issue.mock.calls.length}`, expiresInSeconds: 3600 }))
    const cache = createTokenCache(issue)
    const call = vi
      .fn()
      .mockRejectedValueOnce(new DigitalMailboxApiError('kivra', 'auth', 'expired', 401))
      .mockResolvedValueOnce('ok')
    await expect(withToken(cache, call)).resolves.toBe('ok')
    expect(call.mock.calls.map((c) => c[0])).toEqual(['t1', 't2'])

    const forbidden = vi.fn().mockRejectedValue(new DigitalMailboxApiError('kivra', 'auth', 'scope', 403))
    await expect(withToken(cache, forbidden)).rejects.toMatchObject({ status: 403 })
    expect(forbidden).toHaveBeenCalledTimes(1)
  })
})
