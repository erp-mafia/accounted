import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { getBankPaymentsUsage, isUsagePeriod, usagePeriodBounds } from '../usage'

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

describe('getBankPaymentsUsage', () => {
  it('counts the payments that reached the provider and the accounts they left from, against the allowance', async () => {
    const db = createTableMockSupabase({
      payment_orders: { data: [{ cash_account_id: 'a1' }, { cash_account_id: 'a1' }, { cash_account_id: 'a2' }] },
    })
    const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
    expect(usage).toEqual({
      period: '2026-10',
      payments_sent: 3,
      accounts_used: 2,
      included_payments: 30,
      included_accounts: 2,
      extra_payments: 0,
      extra_accounts: 0,
    })
    // Only orders with a provider payment id, created inside the month, for this company.
    expect(db.findCall('payment_orders', 'not')).toEqual(['provider_payment_id', 'is', null])
    expect(db.findCall('payment_orders', 'gte')).toEqual(['created_at', '2026-09-30T22:00:00.000Z'])
    expect(db.findCall('payment_orders', 'lt')).toEqual(['created_at', '2026-10-31T23:00:00.000Z'])
  })

  it('reports what is beyond the allowance', async () => {
    const rows = Array.from({ length: 33 }, (_, i) => ({ cash_account_id: `a${i % 3}` }))
    const db = createTableMockSupabase({ payment_orders: { data: rows } })
    const usage = await getBankPaymentsUsage(db.supabase as unknown as SupabaseClient, 'c0000000-0000-4000-8000-000000000001', '2026-10')
    expect(usage).toMatchObject({ payments_sent: 33, accounts_used: 3, extra_payments: 3, extra_accounts: 1 })
  })
})
