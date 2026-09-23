import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  cashAccountSeriesOverride,
  resolveCashAccountVoucherSeries,
} from '../cash-account-voucher-series'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

describe('cashAccountSeriesOverride', () => {
  it('returns the letter when the account carries a valid override', () => {
    expect(cashAccountSeriesOverride({ voucher_series: 'M' })).toBe('M')
  })

  it('returns undefined for null, missing, lowercase or multi-letter values', () => {
    expect(cashAccountSeriesOverride(null)).toBeUndefined()
    expect(cashAccountSeriesOverride(undefined)).toBeUndefined()
    expect(cashAccountSeriesOverride({ voucher_series: null })).toBeUndefined()
    expect(cashAccountSeriesOverride({})).toBeUndefined()
    expect(cashAccountSeriesOverride({ voucher_series: 'm' })).toBeUndefined()
    expect(cashAccountSeriesOverride({ voucher_series: 'AB' })).toBeUndefined()
    expect(cashAccountSeriesOverride({ voucher_series: '' })).toBeUndefined()
  })
})

describe('resolveCashAccountVoucherSeries', () => {
  beforeEach(() => {
    reset()
  })

  it('skips the lookup entirely when the transaction has no cash account', async () => {
    expect(await resolveCashAccountVoucherSeries(supabase as never, 'company-1', null)).toBeUndefined()
    expect(await resolveCashAccountVoucherSeries(supabase as never, 'company-1', undefined)).toBeUndefined()
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('returns the account override, scoped to the company', async () => {
    enqueue({ data: { voucher_series: 'M' }, error: null })

    const series = await resolveCashAccountVoucherSeries(supabase as never, 'company-1', 'ca-1')

    expect(series).toBe('M')
    const eqCalls = findCalls('cash_accounts', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['id', 'ca-1'])
  })

  it('returns undefined when the account has no override', async () => {
    enqueue({ data: { voucher_series: null }, error: null })
    expect(await resolveCashAccountVoucherSeries(supabase as never, 'company-1', 'ca-1')).toBeUndefined()
  })

  it('returns undefined when the account is unknown', async () => {
    enqueue({ data: null, error: null })
    expect(await resolveCashAccountVoucherSeries(supabase as never, 'company-1', 'ca-missing')).toBeUndefined()
  })

  it('fails open (undefined) on a query error so the booking still goes through', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    expect(await resolveCashAccountVoucherSeries(supabase as never, 'company-1', 'ca-1')).toBeUndefined()
  })
})
