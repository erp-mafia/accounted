/**
 * The payments_verification_renewal row (../categories.ts): derived from the
 * stored verification record alone, only for a company the pilot or the plan admits, only
 * when the verification is expiring or expired.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const doorMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/payments/orders/pilot', () => ({ paymentsAdmitted: (...args: unknown[]) => doorMock(...args) }))

import { countPaymentsVerificationDue, listPaymentsVerificationDue } from '../categories'
import { getWorklistCounts } from '../aggregate'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-10-13T10:00:00Z')
let db: ReturnType<typeof createTableMockSupabase>

function record(overrides: Record<string, unknown> = {}) {
  return {
    company_id: COMPANY,
    status: 'valid',
    valid_until: '2027-10-03',
    checked_at: '2026-10-13T09:00:00Z',
    link_created_at: null,
    link_expires_at: null,
    handed_off_at: null,
    started_by: null,
    updated_at: '2026-10-13T09:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  doorMock.mockResolvedValue({ ok: true })
  db = createTableMockSupabase()
})

const supabase = () => db.supabase as unknown as SupabaseClient

describe('listPaymentsVerificationDue', () => {
  it('is null for a company that never verified, and for one still valid for long', async () => {
    db.setTable('company_payment_verifications', { data: null })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    db.setTable('company_payment_verifications', { data: record() })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    // The row never calls the provider: only the stored record is read, without the form URL.
    expect(db.tables()).toEqual(['company_payment_verifications', 'company_payment_verifications'])
    expect(db.findCall('company_payment_verifications', 'select')![0]).not.toMatch(/link_url/)
  })

  it('shows the row with the days left when valid_until is within 30 days, and as expired once it passed or the provider says invalid', async () => {
    db.setTable('company_payment_verifications', { data: record({ valid_until: '2026-11-01' }) })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toEqual({ state: 'expiring', valid_until: '2026-11-01', days_left: 19 })
    expect(await countPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBe(1)

    db.setTable('company_payment_verifications', { data: record({ valid_until: '2026-10-01' }) })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toEqual({ state: 'expired', valid_until: '2026-10-01', days_left: -12 })

    db.setTable('company_payment_verifications', { data: record({ status: 'invalid', valid_until: '2026-09-01' }) })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toMatchObject({ state: 'expired' })
  })

  it('is null while a renewal form is open after the lapse, and for a company outside the plan', async () => {
    db.setTable('company_payment_verifications', {
      data: record({ status: 'invalid', valid_until: '2026-10-01', link_created_at: '2026-10-13T09:00:00Z', link_expires_at: '2026-10-14T09:00:00Z' }),
    })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()

    doorMock.mockResolvedValueOnce({ ok: false, reason: 'subscription' })
    db.setTable('company_payment_verifications', { data: record({ valid_until: '2026-10-20' }) })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    expect(db.tables()).toEqual(['company_payment_verifications'])
  })

  it('soft-fails to nothing due when the read breaks', async () => {
    db.setTable('company_payment_verifications', { error: { message: 'boom' } })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    expect(await countPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBe(0)
  })
})

describe('getWorklistCounts', () => {
  it('counts the renewal row from the list the caller already fetched, and in the total', async () => {
    const counts = await getWorklistCounts(supabase(), COMPANY, {
      suggestedMatches: [],
      expensePayoutsDue: [],
      skattekontoPaymentDue: null,
      bankSwitchDue: [],
      paymentsVerificationDue: { state: 'expiring', valid_until: '2026-11-01', days_left: 19 },
    })
    expect(counts.counts.payments_verification_renewal).toBe(1)
    expect(counts.total).toBeGreaterThanOrEqual(1)
    expect(doorMock).not.toHaveBeenCalled()

    const none = await getWorklistCounts(supabase(), COMPANY, { suggestedMatches: [], expensePayoutsDue: [], skattekontoPaymentDue: null, bankSwitchDue: [], paymentsVerificationDue: null })
    expect(none.counts.payments_verification_renewal).toBe(0)
  })
})
