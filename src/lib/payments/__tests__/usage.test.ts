import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { BANK_PAYMENTS_INCLUDED_PER_MONTH, BANK_PAYMENTS_SAFETY_CEILING, getBankPaymentsUsage, isUsagePeriod, readBankPaymentsMonth, usagePeriodBounds } from '../usage'
import { createPayrollFakeDb } from '@/lib/salary/__tests__/payroll-fake-db'
import { paymentOrderRow } from './payment-order-row'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'

describe('usagePeriodBounds', () => {
  it('spans the month in Stockholm time, across the summer-time change', () => {
    expect(usagePeriodBounds('2026-10')).toEqual({ start: '2026-09-30T22:00:00.000Z', end: '2026-10-31T23:00:00.000Z' })
    expect(usagePeriodBounds('2026-12')).toEqual({ start: '2026-11-30T23:00:00.000Z', end: '2026-12-31T23:00:00.000Z' })
    expect(usagePeriodBounds('2026-07')).toEqual({ start: '2026-06-30T22:00:00.000Z', end: '2026-07-31T22:00:00.000Z' })
  })

  it('accepts only YYYY-MM', () => {
    expect(isUsagePeriod('2026-10')).toBe(true)
    expect(isUsagePeriod('2026-13')).toBe(false)
    expect(isUsagePeriod('2026-10-01')).toBe(false)
    expect(isUsagePeriod(null)).toBe(false)
  })
})

// A subscription of its own: what lets more than what is included be offered.
const PAYING = {
  company_subscriptions: { data: { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' } },
  company_settings: { data: { is_sandbox: false } },
}

describe('getBankPaymentsUsage', () => {
  it('offers more at the unit price, and keeps the stop at what is included until an admin accepts', async () => {
    process.env.USAGE_BILLING_KINDS = 'bank_payment'
    try {
      const db = createTableMockSupabase({ payment_orders: { data: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, cash_account_id: 'a1' })) }, ...PAYING })
      const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, COMPANY, '2026-10')
      expect(usage).toMatchObject({ included_payments: 10, cap_payments: 10, extra_offered: true, billed_above_included: false, subscription_required: false, remaining_payments: 0 })
    } finally {
      delete process.env.USAGE_BILLING_KINDS
    }
  })

  it('offers nothing more to a company without a subscription of its own, and says one is needed', async () => {
    process.env.USAGE_BILLING_KINDS = 'bank_payment'
    try {
      const db = createTableMockSupabase({ payment_orders: { data: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, cash_account_id: 'a1' })) } })
      const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, COMPANY, '2026-10')
      expect(usage).toMatchObject({ cap_payments: 10, extra_offered: false, billed_above_included: false, subscription_required: true, remaining_payments: 0 })
    } finally {
      delete process.env.USAGE_BILLING_KINDS
    }
  })

  it('moves the stop to the safety ceiling and names the unit price once an admin accepted', async () => {
    process.env.USAGE_BILLING_KINDS = 'bank_payment'
    try {
      const db = createTableMockSupabase({
        payment_orders: { data: Array.from({ length: 14 }, (_, i) => ({ id: `o${i}`, cash_account_id: 'a1' })) },
        usage_consents: { data: [{ company_id: COMPANY, kind: 'bank_payment', unit_price_ore: 200, included: 10, accepted_by: 'u1', accepted_at: '2026-10-02T08:00:00Z' }] },
        ...PAYING,
      })
      const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, COMPANY, '2026-10')
      expect(usage).toMatchObject({
        payments_sent: 14,
        included_payments: 10,
        cap_payments: BANK_PAYMENTS_SAFETY_CEILING,
        extra_offered: true,
        billed_above_included: true,
        unit_price_ore: 200,
        remaining_payments: BANK_PAYMENTS_SAFETY_CEILING - 14,
        extra_payments: 4,
      })
    } finally {
      delete process.env.USAGE_BILLING_KINDS
    }
  })

  it('counts the payments that reached the provider and the accounts they left from, against the default cap', async () => {
    const db = createTableMockSupabase({
      payment_orders: { data: [{ id: 'o1', cash_account_id: 'a1' }, { id: 'o2', cash_account_id: 'a1' }, { id: 'o3', cash_account_id: 'a2' }] },
    })
    const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
    expect(usage).toEqual({
      period: '2026-10',
      payments_sent: 3,
      accounts_used: 2,
      included_payments: 10,
      included_accounts: 2,
      cap_payments: 10,
      extra_offered: false,
      billed_above_included: false,
      subscription_required: false,
      unit_price_ore: 200,
      remaining_payments: 7,
      extra_payments: 0,
      extra_accounts: 0,
    })
    expect(BANK_PAYMENTS_INCLUDED_PER_MONTH).toBe(10)
    // Only orders with a provider payment id, sent to the bank inside the month, for this company.
    expect(db.findCall('payment_orders', 'not')).toEqual(['provider_payment_id', 'is', null])
    expect(db.findCall('payment_orders', 'gte')).toEqual(['submitted_at', '2026-09-30T22:00:00.000Z'])
    expect(db.findCall('payment_orders', 'lt')).toEqual(['submitted_at', '2026-10-31T23:00:00.000Z'])
    // The company's own allowance is asked for, and its absence means the default.
    expect(db.findCall('company_bank_payment_allowances', 'eq')).toEqual(['company_id', 'c0000000-0000-4000-8000-000000000001'])
  })

  it('counts a payment in the month it was sent to the bank, not the month it was drafted (#127)', async () => {
    const { supabase } = createPayrollFakeDb({
      payment_orders: [
        // Drafted 30 October, signed and sent 2 November.
        paymentOrderRow(COMPANY, 'late', { created: '2026-10-30T08:00:00.000Z', sent: '2026-11-02T09:00:00.000Z' }),
        // Sent at 23:30 on 31 October, Stockholm time.
        paymentOrderRow(COMPANY, 'october', { created: '2026-10-05T08:00:00.000Z', sent: '2026-10-31T22:30:00.000Z' }),
        // Drafted in October and never sent.
        paymentOrderRow(COMPANY, 'unsent', { created: '2026-10-29T08:00:00.000Z', sent: null }),
      ],
    })

    expect((await readBankPaymentsMonth(supabase, COMPANY, '2026-10')).sent.map((r) => r.id)).toEqual(['october'])
    expect((await readBankPaymentsMonth(supabase, COMPANY, '2026-11')).sent.map((r) => r.id)).toEqual(['late'])
    expect(await getBankPaymentsUsage(supabase, COMPANY, '2026-11')).toMatchObject({ period: '2026-11', payments_sent: 1, remaining_payments: BANK_PAYMENTS_INCLUDED_PER_MONTH - 1 })
  })

  it('uses the allowance a founder set for the company instead of the default', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, cash_account_id: 'a1' }))
    const db = createTableMockSupabase({
      payment_orders: { data: rows },
      company_bank_payment_allowances: { data: { monthly_payments: 40 } },
    })
    const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
    expect(usage).toMatchObject({ payments_sent: 12, included_payments: 40, remaining_payments: 28, extra_payments: 0 })
  })

  it('takes an allowance of 0 as a stop, not as the default', async () => {
    const db = createTableMockSupabase({
      payment_orders: { data: [] },
      company_bank_payment_allowances: { data: { monthly_payments: 0 } },
    })
    const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
    expect(usage).toMatchObject({ included_payments: 0, remaining_payments: 0 })
  })

  it('reports what is beyond the cap (a race), with nothing remaining', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, cash_account_id: `a${i % 3}` }))
    const db = createTableMockSupabase({ payment_orders: { data: rows } })
    const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
    expect(usage).toMatchObject({ payments_sent: 13, accounts_used: 3, remaining_payments: 0, extra_payments: 3, extra_accounts: 1 })
  })

  it('throws when the allowance cannot be read, so the cap never falls back silently', async () => {
    const db = createTableMockSupabase({
      payment_orders: { data: [] },
      company_bank_payment_allowances: { data: null, error: { message: 'boom' } },
    })
    await expect(getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')).rejects.toBeTruthy()
  })

  it('reads a missing allowance table (deploy before the migration) as the default cap, so signings keep working', async () => {
    for (const code of ['PGRST205', '42P01']) {
      const db = createTableMockSupabase({
        payment_orders: { data: [{ id: 'o1', cash_account_id: 'a1' }] },
        company_bank_payment_allowances: { data: null, error: { code, message: 'relation does not exist' } },
      })
      const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
      expect(usage.included_payments).toBe(BANK_PAYMENTS_INCLUDED_PER_MONTH)
      expect(usage.remaining_payments).toBe(BANK_PAYMENTS_INCLUDED_PER_MONTH - 1)
    }
  })
})
