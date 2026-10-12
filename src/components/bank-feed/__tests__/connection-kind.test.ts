import { describe, expect, it } from 'vitest'
import { connectionKind, consentState } from '../connection-kind'

describe('connectionKind', () => {
  it('tells an Open Payments row from an Enable Banking one by its provider', () => {
    expect(connectionKind({ provider: 'open_payments' })).toBe('open_payments')
    expect(connectionKind({ provider: 'open-payments' })).toBe('open_payments')
    expect(connectionKind({ provider: 'OpenPayments' })).toBe('open_payments')
    expect(connectionKind({ provider: 'swedbank-se' })).toBe('enable_banking')
    expect(connectionKind({ provider: null })).toBe('enable_banking')
  })
})

describe('consentState', () => {
  const now = Date.parse('2026-10-12T10:00:00Z')

  it('is active far from expiry, asks for a renewal inside 14 days, and reports an expired consent', () => {
    expect(consentState('2027-01-10T00:00:00Z', now)).toEqual({ kind: 'active', until: '2027-01-10T00:00:00Z' })
    expect(consentState('2026-10-20T00:00:00Z', now)).toEqual({ kind: 'renew_by', until: '2026-10-20T00:00:00Z' })
    expect(consentState('2026-10-26T10:00:00Z', now)).toEqual({ kind: 'renew_by', until: '2026-10-26T10:00:00Z' })
    expect(consentState('2026-10-01T00:00:00Z', now)).toEqual({ kind: 'expired', until: '2026-10-01T00:00:00Z' })
  })

  it('is unknown without a usable date', () => {
    expect(consentState(null, now)).toEqual({ kind: 'unknown' })
    expect(consentState('soon', now)).toEqual({ kind: 'unknown' })
  })
})
