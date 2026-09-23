import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getLatestPostedVouchers } from '../latest-vouchers'
import { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from '../latest-vouchers-format'
import { createQueuedMockSupabase } from '@/tests/helpers'
import enMessages from '../../../messages/en.json'
import svMessages from '../../../messages/sv.json'

beforeEach(() => {
  vi.clearAllMocks()
})

interface Row {
  id: string
  voucher_series: string | null
  voucher_number: number
}

function row(id: string, series: string | null, number: number): Row {
  return { id, voucher_series: series, voucher_number: number }
}

describe('getLatestPostedVouchers', () => {
  it('returns the highest number per series, sorted by series', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: [
        row('e1', 'B', 12),
        row('e2', 'A', 214),
        row('e3', 'A', 7),
        row('e4', 'B', 37),
        row('e5', 'A', 100),
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

  it('excludes drafts and cancelled entries, which is what voucher_number > 0 buys', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [row('e1', 'A', 5)], error: null })

    await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-12-31' }
    )

    // Drafts and cancelled entries both carry voucher_number = 0.
    expect(q.findCall('journal_entries', 'gt')).toEqual(['voucher_number', 0])
    // Reversed entries keep their number and their slot in the series, so they
    // count: excluding them would report a gap that is not there.
    const statusFilter = q.findCall('journal_entries', 'in')
    expect(statusFilter?.[0]).toBe('status')
    expect(statusFilter?.[1]).toEqual(['posted', 'reversed'])
  })

  it('bounds the window by toDate only when no fromDate is given (balansrapport)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [row('e1', 'A', 5)], error: null })

    await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-03-31' }
    )

    expect(q.findCall('journal_entries', 'lte')).toEqual(['entry_date', '2026-03-31'])
    // The fiscal period filter is the lower bound; no explicit gte.
    expect(q.findCall('journal_entries', 'gte')).toBeUndefined()
    expect(q.findCall('journal_entries', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('bounds both ends when fromDate is given (resultatrapport)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [row('e1', 'A', 5)], error: null })

    await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { fromDate: '2026-01-01', toDate: '2026-03-31' }
    )

    expect(q.findCall('journal_entries', 'gte')).toEqual(['entry_date', '2026-01-01'])
    expect(q.findCall('journal_entries', 'lte')).toEqual(['entry_date', '2026-03-31'])
  })

  it('orders on the primary key so paging cannot skip or duplicate rows', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [row('e1', 'A', 5)], error: null })

    await getLatestPostedVouchers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q.supabase as any,
      'company-1',
      'period-1',
      { toDate: '2026-12-31' }
    )

    expect(q.findCall('journal_entries', 'order')).toEqual(['id', { ascending: true }])
  })

  it('falls back to series A for entries with a null voucher_series', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [row('e1', null, 9), row('e2', 'A', 4)], error: null })

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
