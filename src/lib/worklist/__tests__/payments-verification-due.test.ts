/**
 * The payments_verification_renewal row (../categories.ts): derived from the
 * stored verification record alone, only for a company the pilot or the plan admits, only
 * when the verification is expiring or expired, or was never started by a
 * company that pays its suppliers here.
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

describe('listPaymentsVerificationDue, the first verification', () => {
  // The provider answered not verified and nobody made a form here.
  const notStarted = () => record({ status: 'invalid', valid_until: null })
  const businessAccount = {
    id: 'acct-1',
    name: 'Företagskonto',
    ledger_account: '1930',
    iban: 'SE3550000000054910000003',
    currency: 'SEK',
    enabled: true,
    bank_connection: { bank_name: 'Swedbank', affiliated_aspsp_id: null, psu_type: 'business' },
  }
  const personalAccount = { ...businessAccount, bank_connection: { ...businessAccount.bank_connection, psu_type: 'personal' } }

  beforeEach(() => {
    db.setTable('company_payment_verifications', { data: notStarted() })
    db.setTable('payment_orders', { data: [] })
    db.setTable('supplier_payment_batches', { data: [{ id: 'batch-1' }] })
    db.setTable('cash_accounts', { data: [businessAccount] })
  })

  it('shows the row for a company that made a payment file in 60 days and pays from a business account', async () => {
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toEqual({ state: 'not_started', valid_until: null, days_left: null })
    expect(await countPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBe(1)
    // The window is the last 60 days, from now.
    expect(db.findCall('supplier_payment_batches', 'gte')).toEqual(['created_at', '2026-08-14T10:00:00.000Z'])
  })

  it('counts a bank payment as well as a payment file', async () => {
    db.setTable('payment_orders', { data: [{ id: 'order-1' }] })
    db.setTable('supplier_payment_batches', { data: [] })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toMatchObject({ state: 'not_started' })
  })

  it('is null without a payment or payment file in 60 days', async () => {
    db.setTable('supplier_payment_batches', { data: [] })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    expect(db.tables()).not.toContain('cash_accounts')
  })

  it("is null when every account pays as the owner's private one: such a payment is tried without the verification", async () => {
    db.setTable('cash_accounts', { data: [personalAccount] })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
  })

  it('is null once a form was made (started, not finished), with nothing on file, and when verified', async () => {
    db.setTable('company_payment_verifications', { data: record({ status: 'invalid', valid_until: null, link_created_at: '2026-10-11T09:00:00Z', link_expires_at: '2026-10-12T09:00:00Z' }) })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    db.setTable('company_payment_verifications', { data: null })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    db.setTable('company_payment_verifications', { data: record() })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
    expect(db.tables()).not.toContain('supplier_payment_batches')
  })

  it('soft-fails to nothing due when the activity read breaks', async () => {
    db.setTable('supplier_payment_batches', { error: { message: 'boom' } })
    expect(await listPaymentsVerificationDue(supabase(), COMPANY, NOW)).toBeNull()
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
