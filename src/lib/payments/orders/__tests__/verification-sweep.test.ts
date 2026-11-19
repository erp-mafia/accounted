/**
 * The daily verification sweep (../verification-sweep.ts): refreshes the
 * records nobody asked about for a day, skips companies whose door is closed,
 * counts the ones whose renewal is due, and never asks a bank twice in a run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { PaymentProviderError, registerPaymentInitiationProvider, resetPaymentInitiationProviders } from '@/lib/payments/initiation/provider'

vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('the sweep writes with the cron writer, never a new client') } }))

import { hasCapability } from '@/lib/entitlements/has-capability'
import { sweepPaymentVerifications, VERIFICATION_SWEEP_AFTER_MS, VERIFICATION_SWEEP_LIMIT } from '../verification-sweep'
import { fakeProvider } from './fixtures'

const NOW = new Date('2026-10-13T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const A = 'a0000000-0000-4000-8000-000000000001'
const B = 'b0000000-0000-4000-8000-000000000002'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
let db: ReturnType<typeof createTableMockSupabase>

function record(companyId: string, overrides: Record<string, unknown> = {}) {
  return {
    company_id: companyId,
    status: 'valid',
    valid_until: '2027-10-03',
    checked_at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    link_created_at: null,
    link_expires_at: null,
    handed_off_at: null,
    started_by: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  vi.mocked(hasCapability).mockResolvedValue(true)
  db = createTableMockSupabase({ company_settings: { data: { org_number: '5560160680' } } })
})

describe('sweepPaymentVerifications', () => {
  it('is a truthful no-op without a payments provider', async () => {
    expect(await sweepPaymentVerifications(db.supabase as unknown as SupabaseClient, log, NOW)).toEqual({
      considered: 0,
      refreshed: 0,
      renewalDue: 0,
      skipped: { doorClosed: 0, noOrgNumber: 0 },
      deferred: 0,
      errors: 0,
      noProvider: true,
    })
    expect(db.tables()).toEqual([])
  })

  it('refreshes the records older than a day, oldest first and bounded, and counts the renewals now due', async () => {
    const answers = new Map([
      [A, { status: 'valid' as const, validUntil: '2026-11-01' }], // 19 days: expiring
      [B, { status: 'valid' as const, validUntil: '2027-10-03' }],
    ])
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockImplementation(async (party: { companyId: string }) => answers.get(party.companyId)) })
    registerPaymentInitiationProvider(provider)
    db.setTable('company_payment_verifications', [
      { data: [record(A), record(B)] },
      { data: null }, // upsert A
      { data: record(A, { valid_until: '2026-11-01', checked_at: NOW.toISOString() }) },
      { data: null }, // upsert B
      { data: record(B, { checked_at: NOW.toISOString() }) },
    ])

    const result = await sweepPaymentVerifications(db.supabase as unknown as SupabaseClient, log, NOW)

    expect(result).toEqual({ considered: 2, refreshed: 2, renewalDue: 1, skipped: { doorClosed: 0, noOrgNumber: 0 }, deferred: 0, errors: 0 })
    expect(provider.getCompanyVerification).toHaveBeenCalledTimes(2)
    const before = new Date(NOW.getTime() - VERIFICATION_SWEEP_AFTER_MS).toISOString()
    expect(db.findCall('company_payment_verifications', 'or')).toEqual([`checked_at.is.null,checked_at.lt.${before}`])
    expect(db.findCall('company_payment_verifications', 'order')).toEqual(['checked_at', { ascending: true, nullsFirst: true }])
    expect(db.findCall('company_payment_verifications', 'limit')).toEqual([VERIFICATION_SWEEP_LIMIT])
    const upserts = db.payloads('company_payment_verifications', 'upsert') as Array<Record<string, unknown>>
    expect(upserts).toEqual([
      { company_id: A, status: 'valid', valid_until: '2026-11-01', checked_at: NOW.toISOString() },
      { company_id: B, status: 'valid', valid_until: '2027-10-03', checked_at: NOW.toISOString() },
    ])
  })

  it('skips a company whose payments door is closed and one without an organisationsnummer, and keeps going past a provider failure', async () => {
    const provider = fakeProvider({
      getCompanyVerification: vi
        .fn()
        .mockRejectedValueOnce(new PaymentProviderError('down', 'TIMEOUT', true, 504))
        .mockResolvedValueOnce({ status: 'invalid', validUntil: '2026-09-01' }),
    })
    registerPaymentInitiationProvider(provider)
    const C = 'c0000000-0000-4000-8000-000000000003'
    const D = 'd0000000-0000-4000-8000-000000000004'
    vi.mocked(hasCapability).mockImplementation(async (_s, companyId: string) => companyId !== A)
    db.setTable('company_settings', [{ data: { org_number: null } }, { data: { org_number: '5560160680' } }, { data: { org_number: '5560160680' } }])
    db.setTable('companies', { data: { org_number: null } })
    db.setTable('company_payment_verifications', [
      { data: [record(A), record(B), record(C), record(D)] },
      { data: null }, // upsert D
      { data: record(D, { status: 'invalid', valid_until: '2026-09-01', checked_at: NOW.toISOString() }) },
    ])

    const result = await sweepPaymentVerifications(db.supabase as unknown as SupabaseClient, log, NOW)

    expect(result).toEqual({ considered: 4, refreshed: 1, renewalDue: 1, skipped: { doorClosed: 1, noOrgNumber: 1 }, deferred: 0, errors: 1 })
    expect(provider.getCompanyVerification).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/sweep failed/), { companyId: C, code: 'TIMEOUT' })
    // The lapsed company's record now reads expired: the worklist row shows from the next read.
    expect(db.payloads('company_payment_verifications', 'upsert')).toEqual([{ company_id: D, status: 'invalid', valid_until: '2026-09-01', checked_at: NOW.toISOString() }])
  })
  it('asks the run budget before each provider call and leaves the rest, oldest answer first, for the next run', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-10-03' }) })
    registerPaymentInitiationProvider(provider)
    const C = 'c0000000-0000-4000-8000-000000000003'
    db.setTable('company_payment_verifications', [
      { data: [record(A), record(B), record(C)] },
      { data: null }, // upsert A
      { data: record(A, { checked_at: NOW.toISOString() }) },
    ])
    const allows = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)

    const result = await sweepPaymentVerifications(db.supabase as unknown as SupabaseClient, log, NOW, { deadline: 0, allows })

    expect(result).toMatchObject({ considered: 1, refreshed: 1, deferred: 2, errors: 0 })
    expect(provider.getCompanyVerification).toHaveBeenCalledTimes(1)
  })
})
