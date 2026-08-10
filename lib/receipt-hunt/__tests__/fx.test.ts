/**
 * Putting a foreign receipt into kronor. What matters is that it only ever
 * adds a number nobody had, never removes a pair the hunt could already make,
 * and never invents a rate it could not fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { roundOre } from '@/lib/money'
import type { HuntPoolItem } from '../select'

const mockFetchRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchRate(...args),
  convertToSEK: (amount: number, rate: number) => amount * rate,
}))

import { attachSekTotals } from '../fx'

function item(
  currency: string,
  total: number | null,
  date: string | null = '2026-06-15',
  id = 'i1',
): HuntPoolItem {
  return {
    id,
    document_id: `d-${id}`,
    channel_context: null,
    extracted_data: {
      supplier: { name: 'Anthropic, PBC' },
      invoice: { currency, invoiceDate: date },
      totals: { total },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetchRate.mockResolvedValue({ currency: 'EUR', rate: 11.19, date: '2026-06-15' })
})

describe('attachSekTotals', () => {
  it('resolves a foreign total into kronor', async () => {
    // Anthropic bills 180 EUR; the statement reads -2 014,32 kr. Neither
    // number appears in the other document.
    const [out] = await attachSekTotals({} as never, [item('EUR', 180)])
    expect(out.sek_total).toBe(2014.2)
  })

  it('rounds to öre rather than carrying a float into a comparison', async () => {
    mockFetchRate.mockResolvedValue({ currency: 'USD', rate: 9.747, date: '2026-06-19' })
    const [out] = await attachSekTotals({} as never, [item('USD', 104.23)])
    expect(out.sek_total).toBe(roundOre(104.23 * 9.747))
  })

  it('leaves a Swedish receipt alone', async () => {
    const [out] = await attachSekTotals({} as never, [item('SEK', 425)])
    expect(out.sek_total).toBeUndefined()
    expect(mockFetchRate).not.toHaveBeenCalled()
  })

  it('asks for a rate once per currency and day, not once per receipt', async () => {
    // Riksbanken answers 429 to a caller that asks per document, and a run
    // holds a dozen receipts from the same vendor in the same month.
    await attachSekTotals({} as never, [
      item('EUR', 180, '2026-06-15', 'a'),
      item('EUR', 225, '2026-06-15', 'b'),
      item('EUR', 22.5, '2026-06-15', 'c'),
    ])
    expect(mockFetchRate).toHaveBeenCalledTimes(1)
  })

  it('still asks again for another day', async () => {
    await attachSekTotals({} as never, [
      item('EUR', 180, '2026-06-15', 'a'),
      item('EUR', 180, '2026-07-15', 'b'),
    ])
    expect(mockFetchRate).toHaveBeenCalledTimes(2)
  })

  it('leaves the receipt untouched when no rate can be had', async () => {
    // Exactly as incomparable as before, which is the point: the hunt loses
    // nothing it previously had.
    mockFetchRate.mockResolvedValue(null)
    const [out] = await attachSekTotals({} as never, [item('EUR', 180)])
    expect(out.sek_total).toBeUndefined()
  })

  it('survives the rate service failing outright', async () => {
    mockFetchRate.mockRejectedValue(new Error('riksbanken 429'))
    const [out] = await attachSekTotals({} as never, [item('EUR', 180)])
    expect(out.sek_total).toBeUndefined()
  })

  it('does not guess at a currency Riksbanken has no series for', async () => {
    const [out] = await attachSekTotals({} as never, [item('ZWL', 500)])
    expect(out.sek_total).toBeUndefined()
    expect(mockFetchRate).not.toHaveBeenCalled()
  })

  it('refuses to date an undated receipt with today', async () => {
    // Today's rate on a receipt of unknown age would make something
    // incomparable look comparable, which is how a wrong pairing gets
    // confidence it has not earned.
    const [out] = await attachSekTotals({} as never, [item('EUR', 180, null)])
    expect(out.sek_total).toBeUndefined()
  })

  it('ignores a receipt with no total to convert', async () => {
    const [out] = await attachSekTotals({} as never, [item('EUR', null)])
    expect(out.sek_total).toBeUndefined()
    expect(mockFetchRate).not.toHaveBeenCalled()
  })
})
