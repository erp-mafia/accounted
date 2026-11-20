import { describe, it, expect } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { ALL_SERIES_LETTERS, readSeriesInUse, seriesFilterLetters } from '../series-filter-letters'

/**
 * The verifikat list's series filter (crm#1680) offered a fixed A-G while
 * companies number vouchers in J, K, L, M, N and beyond. It now offers the
 * letters the company has vouchers in.
 */
describe('seriesFilterLetters', () => {
  it('offers every single-letter series the company uses, past G, sorted', () => {
    expect(seriesFilterLetters(['N', 'A', 'J', 'B', 'L', 'M', 'A', 'K'])).toEqual(['A', 'B', 'J', 'K', 'L', 'M', 'N'])
  })

  it('leaves out series the list API cannot filter on', () => {
    expect(seriesFilterLetters(['A', 'A_IM', '1', 'EXTERNAL A', 'b', '', null, undefined, 7])).toEqual(['A'])
  })

  it('keeps the active filter selectable even when no voucher uses it', () => {
    expect(seriesFilterLetters(['A'], 'Q')).toEqual(['A', 'Q'])
    expect(seriesFilterLetters([], null)).toEqual([])
  })

  it('offers every letter A-Z when the series could not be read', () => {
    expect(seriesFilterLetters(null)).toEqual([...ALL_SERIES_LETTERS])
    expect(ALL_SERIES_LETTERS).toHaveLength(26)
    expect(ALL_SERIES_LETTERS[0]).toBe('A')
    expect(ALL_SERIES_LETTERS[25]).toBe('Z')
  })
})

describe('readSeriesInUse', () => {
  it("reads the company's own voucher_sequences in one query", async () => {
    const mock = createTableMockSupabase({
      voucher_sequences: { data: [{ voucher_series: 'A' }, { voucher_series: 'L' }, { voucher_series: 'A' }] },
    })
    const series = await readSeriesInUse(mock.supabase as unknown as SupabaseDataClient, 'company-1')
    expect(series).toEqual(['A', 'L', 'A'])
    expect(mock.tables()).toEqual(['voucher_sequences'])
    expect(mock.findCall('voucher_sequences', 'eq')).toEqual(['company_id', 'company-1'])
    expect(seriesFilterLetters(series)).toEqual(['A', 'L'])
  })

  it('throws on a read error so the filter falls back to every letter', async () => {
    const mock = createTableMockSupabase({ voucher_sequences: { error: { message: 'boom' } } })
    await expect(readSeriesInUse(mock.supabase as unknown as SupabaseDataClient, 'company-1')).rejects.toEqual({ message: 'boom' })
  })
})
