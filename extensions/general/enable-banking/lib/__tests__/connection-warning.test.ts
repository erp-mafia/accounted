import { describe, it, expect } from 'vitest'

import { isOneSessionBank, sameBankWarning } from '../connection-warning'

describe('isOneSessionBank', () => {
  it('matches SEB regardless of casing and whitespace', () => {
    expect(isOneSessionBank('SEB')).toBe(true)
    expect(isOneSessionBank(' seb ')).toBe(true)
  })

  it('does not match banks merely containing the letters', () => {
    expect(isOneSessionBank('SEB Kort Bank')).toBe(false)
    expect(isOneSessionBank('Handelsbanken')).toBe(false)
  })
})

describe('sameBankWarning', () => {
  const base = {
    bankName: 'Handelsbanken',
    clashCompanyNames: ['Testbrand AB'],
    clashCount: 1,
    isReconnect: false,
  }

  it('returns null when nothing clashes', () => {
    expect(sameBankWarning({ ...base, clashCompanyNames: [], clashCount: 0 })).toBeNull()
  })

  it('is silent when renewing at a bank without the one-session limit', () => {
    // The regression this module fixes: a user abandoned a legitimate
    // Handelsbanken renewal because the old dialog warned about sibling
    // connections that HB demonstrably tolerates.
    expect(sameBankWarning({ ...base, isReconnect: true })).toBeNull()
  })

  it('calmly confirms a fresh second connection at a bank without the limit', () => {
    const warning = sameBankWarning(base)
    expect(warning).not.toBeNull()
    expect(warning?.confirmLabel).toBe('Anslut')
    expect(warning?.description).not.toContain('sluta synka')
    expect(warning?.description).toContain('Testbrand AB')
  })

  it('hard-warns for a one-session bank on fresh connect', () => {
    const warning = sameBankWarning({ ...base, bankName: 'SEB' })
    expect(warning).not.toBeNull()
    expect(warning?.title).toBe('Du har redan 1 anslutning till SEB')
    expect(warning?.description).toContain('slutar de andra att synka')
    expect(warning?.confirmLabel).toBe('Fortsätt ändå')
  })

  it('hard-warns for a one-session bank on reconnect too', () => {
    // A renewal also mints a new authorization, which at a one-session bank
    // revokes the sibling companies' session just like a fresh connect does.
    const warning = sameBankWarning({ ...base, bankName: 'SEB', isReconnect: true })
    expect(warning).not.toBeNull()
    expect(warning?.description).toContain('slutar de andra att synka')
  })

  it('pluralizes the one-session title and company phrasing', () => {
    const warning = sameBankWarning({
      bankName: 'SEB',
      clashCompanyNames: ['Testbrand AB', 'Provbolaget AB'],
      clashCount: 2,
      isReconnect: false,
    })
    expect(warning?.title).toBe('Du har redan 2 anslutningar till SEB')
    expect(warning?.description).toContain('andra bolag (Testbrand AB, Provbolaget AB)')
  })

  it('omits the company list when no names are known', () => {
    const warning = sameBankWarning({ ...base, clashCompanyNames: [] })
    expect(warning?.description).not.toContain('(')
  })
})
