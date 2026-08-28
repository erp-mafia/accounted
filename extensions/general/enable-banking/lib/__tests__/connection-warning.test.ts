import { describe, it, expect } from 'vitest'

import {
  isOneSessionBank,
  isVerifiedMultiSessionBank,
  sameBankWarning,
  type SameBankClash,
} from '../connection-warning'

function clash(over: Partial<SameBankClash> = {}): SameBankClash {
  return { companyName: 'Testbrand AB', sessionId: 'sess-other', ...over }
}

describe('bank tier matching', () => {
  it('matches SEB regardless of casing and whitespace', () => {
    expect(isOneSessionBank('SEB')).toBe(true)
    expect(isOneSessionBank(' seb ')).toBe(true)
  })

  it('matches Handelsbanken as verified multi-session', () => {
    expect(isVerifiedMultiSessionBank('Handelsbanken')).toBe(true)
    expect(isVerifiedMultiSessionBank('handelsbanken')).toBe(true)
  })

  it('does not match banks merely containing the letters, nor null', () => {
    expect(isOneSessionBank('SEB Kort Bank')).toBe(false)
    expect(isOneSessionBank(null)).toBe(false)
    expect(isOneSessionBank(undefined)).toBe(false)
    expect(isVerifiedMultiSessionBank('Nordea')).toBe(false)
  })
})

describe('sameBankWarning', () => {
  const base = {
    bankName: 'Handelsbanken',
    clashes: [clash()],
    isReconnect: false,
  }

  it('returns null when nothing clashes', () => {
    expect(sameBankWarning({ ...base, clashes: [] })).toBeNull()
  })

  it('is silent when renewing at a verified multi-session bank', () => {
    // The regression this module fixes: a user abandoned a legitimate
    // Handelsbanken renewal because the old dialog warned about sibling
    // connections that HB demonstrably tolerates.
    expect(sameBankWarning({ ...base, isReconnect: true })).toBeNull()
  })

  it('calmly confirms a fresh second connection at a verified multi-session bank', () => {
    const warning = sameBankWarning(base)
    expect(warning).not.toBeNull()
    expect(warning?.confirmLabel).toBe('Anslut')
    expect(warning?.description).not.toContain('sluta synka')
    expect(warning?.description).toContain('Testbrand AB')
  })

  it('hard-warns for a one-session bank on fresh connect and reconnect alike', () => {
    // A renewal also mints a new authorization, which at a one-session bank
    // revokes the sibling companies' session just like a fresh connect does.
    for (const isReconnect of [false, true]) {
      const warning = sameBankWarning({ ...base, bankName: 'SEB', isReconnect })
      expect(warning?.title).toBe('Du har redan 1 anslutning till SEB')
      expect(warning?.description).toContain('slutar de andra att synka')
      expect(warning?.confirmLabel).toBe('Fortsätt ändå')
    }
  })

  it('keeps the hedged warning for banks with unknown session policy, on both paths', () => {
    // Fail closed: absence of evidence about a bank is not evidence that it
    // tolerates parallel sessions, so unknown banks keep the old behavior.
    for (const isReconnect of [false, true]) {
      const warning = sameBankWarning({ ...base, bankName: 'Nordea', isReconnect })
      expect(warning).not.toBeNull()
      expect(warning?.description).toContain('Vissa banker tillåter bara en aktiv anslutning')
      expect(warning?.description).toContain('kan de andra sluta synka')
      expect(warning?.confirmLabel).toBe('Fortsätt')
    }
  })

  it('exempts siblings sharing the session being renewed', () => {
    // fanOutSessionRenewal carries the renewed session to every sibling on
    // it, so they never break and must not trigger the warning: even at SEB,
    // even at an unknown bank.
    for (const bankName of ['SEB', 'Nordea']) {
      const warning = sameBankWarning({
        bankName,
        clashes: [clash({ sessionId: 'sess-current' })],
        isReconnect: true,
        currentSessionId: 'sess-current',
      })
      expect(warning).toBeNull()
    }
  })

  it('still warns about siblings on OTHER sessions when renewing', () => {
    const warning = sameBankWarning({
      bankName: 'SEB',
      clashes: [
        clash({ sessionId: 'sess-current', companyName: 'Delad AB' }),
        clash({ sessionId: 'sess-other', companyName: 'Separat AB' }),
      ],
      isReconnect: true,
      currentSessionId: 'sess-current',
    })
    expect(warning?.title).toBe('Du har redan 1 anslutning till SEB')
    expect(warning?.description).toContain('Separat AB')
    expect(warning?.description).not.toContain('Delad AB')
  })

  it('never exempts on null session ids', () => {
    // A null on either side proves nothing about sharing.
    const warning = sameBankWarning({
      bankName: 'SEB',
      clashes: [clash({ sessionId: null })],
      isReconnect: true,
      currentSessionId: null,
    })
    expect(warning).not.toBeNull()
  })

  it('dedupes company names and phrases by company count', () => {
    // One company can hold two connections (privat + företag) to one bank:
    // that is still "ett annat bolag", named once.
    const warning = sameBankWarning({
      bankName: 'SEB',
      clashes: [
        clash({ sessionId: 'a' }),
        clash({ sessionId: 'b' }),
      ],
      isReconnect: false,
    })
    expect(warning?.title).toBe('Du har redan 2 anslutningar till SEB')
    expect(warning?.description).toContain('ett annat bolag (Testbrand AB)')
    expect(warning?.description).not.toContain('Testbrand AB, Testbrand AB')
  })

  it('pluralizes across distinct companies', () => {
    const warning = sameBankWarning({
      bankName: 'SEB',
      clashes: [
        clash({ companyName: 'Testbrand AB' }),
        clash({ companyName: 'Provbolaget AB', sessionId: 'sess-2' }),
      ],
      isReconnect: false,
    })
    expect(warning?.description).toContain('andra bolag (Testbrand AB, Provbolaget AB)')
  })

  it('omits the company list when no names are known', () => {
    const warning = sameBankWarning({
      ...base,
      bankName: 'SEB',
      clashes: [clash({ companyName: null })],
    })
    expect(warning?.description).not.toContain('(')
  })

  it('survives a null bank name', () => {
    const warning = sameBankWarning({ ...base, bankName: null })
    expect(warning).not.toBeNull()
    expect(warning?.title).toContain('Banken')
  })
})
