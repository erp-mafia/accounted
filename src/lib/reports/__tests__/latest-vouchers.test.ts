import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getLatestPostedVouchers } from '../latest-vouchers'
import { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from '../latest-vouchers-format'
import { createQueuedMockSupabase } from '@/tests/helpers'
import enMessages from '../../../messages/en.json'
import svMessages from '../../../messages/sv.json'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getLatestPostedVouchers', () => {
  it('returns the highest number per series from the SQL function, sorted by series', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: [
        { voucher_series: 'B', last_number: 37 },
        { voucher_series: 'A', last_number: 214 },
      ],
      error: null,
    })

    const result = await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-12-31' }
    )

    expect(result).toEqual([
      { series: 'A', last_number: 214 },
      { series: 'B', last_number: 37 },
    ])
  })

  it('returns an empty array when the window holds no posted vouchers', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [], error: null })

    const result = await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-12-31' }
    )

    expect(result).toEqual([])
  })

  it('bounds the window by toDate only when no fromDate is given (balansrapport)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [{ voucher_series: 'A', last_number: 5 }], error: null })

    await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-03-31' }
    )

    expect(q.supabase.rpc).toHaveBeenCalledWith('latest_posted_vouchers', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_from_date: null,
      p_to_date: '2026-03-31',
    })
  })

  it('bounds both ends when fromDate is given (resultatrapport)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [{ voucher_series: 'A', last_number: 5 }], error: null })

    await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { fromDate: '2026-01-01', toDate: '2026-03-31' }
    )

    expect(q.supabase.rpc).toHaveBeenCalledWith('latest_posted_vouchers', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_from_date: '2026-01-01',
      p_to_date: '2026-03-31',
    })
  })

  it('reads the number as a number even when it arrives as a string', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [{ voucher_series: 'A', last_number: '9' }], error: null })

    const result = await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-12-31' }
    )

    expect(result).toEqual([{ series: 'A', last_number: 9 }])
  })

  it('propagates a query error so the caller can decide (engines swallow it)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: { message: 'boom' } })

    await expect(
      getLatestPostedVouchers(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        q.supabase as any,
        'company-1',
        'period-1',
        { toDate: '2026-12-31' }
      )
    ).rejects.toThrow('boom')
  })
})

describe('formatLatestVouchers', () => {
  it('joins series and number with a comma', () => {
    expect(
      formatLatestVouchers([
        { series: 'A', last_number: 214 },
        { series: 'B', last_number: 37 },
      ])
    ).toBe('A 214, B 37')
  })

  it('returns null for an empty list so surfaces drop the line entirely', () => {
    expect(formatLatestVouchers([])).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(formatLatestVouchers(undefined)).toBeNull()
  })

  it('names the number as posted, not allocated', () => {
    // The distinction is the whole point: an allocated number can sit ahead of
    // the books, and a reconciler told the wrong one chases a phantom gap.
    expect(LATEST_VOUCHERS_LABEL).toBe('Senaste bokförda verifikat')
  })

  it('keeps the web label explicit in both supported locales', () => {
    expect(svMessages.reports.latest_posted_vouchers).toBe(LATEST_VOUCHERS_LABEL)
    expect(enMessages.reports.latest_posted_vouchers).toBe('Latest posted vouchers')
  })
})
