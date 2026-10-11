/**
 * The invoice series continues after a provider migration (agent feedback
 * seq 892914, 929266, 965009): the counter stood at its start value, so the
 * first invoice issued after the move restarted the old series at 001.
 */
import { describe, it, expect } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  advanceInvoiceSeriesPastImported,
  isSeriesOutlier,
  seriesNumberOf,
} from '../invoice-number-series'

describe('seriesNumberOf', () => {
  it('reads bare digits and digits after the company prefix', () => {
    expect(seriesNumberOf('70', null)).toBe(70)
    expect(seriesNumberOf('0070', '')).toBe(70)
    expect(seriesNumberOf('F-0123', 'F-')).toBe(123)
  })

  it('under a prefixed series counts only prefixed numbers', () => {
    // generate_invoice_number writes the prefix: bare digits are another series.
    expect(seriesNumberOf('123', 'F-')).toBeNull()
    expect(seriesNumberOf('535883', 'A')).toBeNull()
    expect(seriesNumberOf('A535', 'A')).toBe(535)
  })

  it('leaves numbers outside the series alone', () => {
    expect(seriesNumberOf('KR-1042', '')).toBeNull()
    expect(seriesNumberOf('2025-001', null)).toBeNull()
    expect(seriesNumberOf('PF-004', 'F-')).toBeNull()
    expect(seriesNumberOf('F-12A', 'F-')).toBeNull()
    expect(seriesNumberOf('', null)).toBeNull()
    expect(seriesNumberOf(null, null)).toBeNull()
    expect(seriesNumberOf('0', null)).toBeNull()
    // Past what the integer counter can hold.
    expect(seriesNumberOf('99999999999', null)).toBeNull()
  })
})

describe('isSeriesOutlier', () => {
  const range = (from: number, to: number) => new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i))

  it('accepts a dense series ending close enough to the counter', () => {
    expect(isSeriesOutlier(range(1, 70), 70, 1)).toBe(false)
    expect(isSeriesOutlier(new Set([1]), 1, 1)).toBe(false)
    expect(isSeriesOutlier(range(1, 3), 3, 1)).toBe(false)
  })

  it('refuses a jump of more than MAX_SERIES_JUMP', () => {
    expect(isSeriesOutlier(range(525_000, 535_883), 535_883, 60_000)).toBe(true)
    expect(isSeriesOutlier(range(1, 10_002), 10_002, 1)).toBe(true)
  })

  it('refuses a stray highest number with a sparse neighbourhood', () => {
    expect(isSeriesOutlier(new Set([...range(1, 70), 9_000]), 9_000, 1)).toBe(true)
  })
})

describe('advanceInvoiceSeriesPastImported', () => {
  const imported = Array.from({ length: 70 }, (_, i) => String(i + 1))

  it('moves a counter at its start value to one past the highest imported number', async () => {
    const { supabase, setTable, findCall } = createTableMockSupabase()
    setTable('company_settings', [
      { data: { invoice_prefix: null, next_invoice_number: 1 } },
      { data: [{ next_invoice_number: 71 }] },
    ])

    const result = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', imported)

    expect(result).toEqual({ advanced: true, from: 1, to: 71 })
    expect(findCall('company_settings', 'update')).toEqual([{ next_invoice_number: 71 }])
    // Conditional: never undoes a counter an invoice moved meanwhile.
    expect(findCall('company_settings', 'lte')).toEqual(['next_invoice_number', 70])
  })

  it('leaves a counter already past the imported numbers untouched', async () => {
    const { supabase, setTable, findCall } = createTableMockSupabase()
    setTable('company_settings', { data: { invoice_prefix: null, next_invoice_number: 20000 } })

    const result = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', imported)

    expect(result).toEqual({ advanced: false, reason: 'already_ahead' })
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('writes nothing when no imported number is in the series', async () => {
    const { supabase, setTable, findCall } = createTableMockSupabase()
    setTable('company_settings', { data: { invoice_prefix: null, next_invoice_number: 1 } })

    const result = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', ['KR-5', 'INV-2025-9'])

    expect(result).toEqual({ advanced: false, reason: 'no_series_numbers' })
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('reports a lost race as already ahead (the conditional update matched nothing)', async () => {
    const { supabase, setTable } = createTableMockSupabase()
    setTable('company_settings', [
      { data: { invoice_prefix: 'F-', next_invoice_number: 5 } },
      { data: [] },
    ])

    const result = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', Array.from({ length: 42 }, (_, i) => `F-${String(i + 1).padStart(4, '0')}`))

    expect(result).toEqual({ advanced: false, reason: 'already_ahead' })
  })

  it('leaves the counter alone when the highest imported number is an outlier', async () => {
    // A prefixed series with bare-digit numbers in the register (another
    // series), and one far-off prefixed number: neither moves the counter.
    const { supabase, setTable, findCall } = createTableMockSupabase()
    setTable('company_settings', { data: { invoice_prefix: 'A', next_invoice_number: 60000 } })

    const bare = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', ['535883', '535882'])
    expect(bare).toEqual({ advanced: false, reason: 'no_series_numbers' })

    const far = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', ['A59990', 'A535883'])
    expect(far).toEqual({ advanced: false, reason: 'outlier', current: 60000, highest: 535883 })
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('leaves the counter alone for a stray number above a short series', async () => {
    const { supabase, setTable, findCall } = createTableMockSupabase()
    setTable('company_settings', { data: { invoice_prefix: null, next_invoice_number: 1 } })

    const result = await advanceInvoiceSeriesPastImported(supabase as never, 'company-1', [...imported, '133701141'])

    expect(result).toEqual({ advanced: false, reason: 'outlier', current: 1, highest: 133701141 })
    expect(findCall('company_settings', 'update')).toBeUndefined()
  })

  it('throws on a failed read so the caller can log it', async () => {
    const { supabase, setTable } = createTableMockSupabase()
    setTable('company_settings', { data: null, error: { message: 'boom' } })

    await expect(advanceInvoiceSeriesPastImported(supabase as never, 'company-1', imported)).rejects.toThrow(
      'invoice series read failed',
    )
  })
})
