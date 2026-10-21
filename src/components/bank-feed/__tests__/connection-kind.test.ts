import { describe, expect, it } from 'vitest'
import { connectionKind, connectionRowState, consentState } from '../connection-kind'

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

describe('connectionRowState', () => {
  const now = Date.parse('2026-10-12T10:00:00Z')
  const ahead = '2027-04-12T21:59:59Z'

  it('reads the stored status before the date: an expired row whose consent date is ahead has ended, never active (crm#1355)', () => {
    expect(connectionRowState('expired', ahead, now)).toEqual({ kind: 'ended' })
    expect(connectionRowState('expired', '2026-10-20T00:00:00Z', now)).toEqual({ kind: 'ended' })
    expect(connectionRowState('expired', null, now)).toEqual({ kind: 'ended' })
    expect(connectionRowState('expired', '2026-10-01T00:00:00Z', now)).toEqual({ kind: 'expired', until: '2026-10-01T00:00:00Z' })
  })

  it('says a failed sync and a missing account choice while the consent lasts, and the date for a live row', () => {
    expect(connectionRowState('error', ahead, now)).toEqual({ kind: 'sync_failed' })
    expect(connectionRowState('pending_selection', ahead, now)).toEqual({ kind: 'choose_accounts' })
    expect(connectionRowState('pending_selection', null, now)).toEqual({ kind: 'choose_accounts' })
    expect(connectionRowState('active', ahead, now)).toEqual({ kind: 'active', until: ahead })
    expect(connectionRowState('active', '2026-10-20T00:00:00Z', now)).toEqual({ kind: 'renew_by', until: '2026-10-20T00:00:00Z' })
    expect(connectionRowState('active', null, now)).toEqual({ kind: 'unknown' })
  })

  it('reports a consent past its date as expired whatever the status still says', () => {
    for (const status of ['active', 'error', 'pending_selection']) {
      expect(connectionRowState(status, '2026-10-01T00:00:00Z', now)).toEqual({ kind: 'expired', until: '2026-10-01T00:00:00Z' })
    }
  })
})
