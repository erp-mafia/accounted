import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  lookupTaxAmount,
  calculateJamkningTax,
  calculateSidoinkomstTax,
  fetchTaxTableRates,
  fetchKommunTaxRates,
  clearTaxTableCache,
  TaxTableUnavailableError,
} from '../tax-tables'
import type { TaxTableRate } from '../tax-tables'

const sampleRates: TaxTableRate[] = [
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 0, incomeTo: 2200, taxAmount: 0 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 2201, incomeTo: 20000, taxAmount: 2800 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 20001, incomeTo: 30000, taxAmount: 5600 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 30001, incomeTo: 40000, taxAmount: 8900 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 40001, incomeTo: 50000, taxAmount: 12500 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 50001, incomeTo: 60000, taxAmount: 16800 },
]

describe('lookupTaxAmount', () => {
  it('returns 0 for income below minimum bracket', () => {
    expect(lookupTaxAmount(33, 1, 1500, sampleRates)).toBe(0)
  })

  it('matches correct bracket for mid-range income', () => {
    expect(lookupTaxAmount(33, 1, 25000, sampleRates)).toBe(5600)
  })

  it('matches bracket boundary exactly', () => {
    expect(lookupTaxAmount(33, 1, 20001, sampleRates)).toBe(5600)
    expect(lookupTaxAmount(33, 1, 30000, sampleRates)).toBe(5600)
  })

  it('uses last bracket for income exceeding all brackets', () => {
    expect(lookupTaxAmount(33, 1, 100000, sampleRates)).toBe(16800)
  })

  it('throws TaxTableUnavailableError when no matching rates exist (no silent 30% fallback)', () => {
    expect(() => lookupTaxAmount(99, 1, 40000, sampleRates)).toThrow(TaxTableUnavailableError)
    expect(() => lookupTaxAmount(99, 1, 40000, sampleRates)).toThrow(/table 99/)
  })

  it('filters by correct column', () => {
    const rates: TaxTableRate[] = [
      ...sampleRates,
      { tableYear: 2026, tableNumber: 33, columnNumber: 2, incomeFrom: 0, incomeTo: 50000, taxAmount: 999 },
    ]
    expect(lookupTaxAmount(33, 2, 30000, rates)).toBe(999)
  })
})

describe('calculateJamkningTax', () => {
  it('calculates tax using custom percentage', () => {
    expect(calculateJamkningTax(40000, 20)).toBe(8000)
  })

  it('rounds to 2 decimal places', () => {
    expect(calculateJamkningTax(33333, 15.5)).toBe(5166.62)
  })
})

describe('calculateSidoinkomstTax', () => {
  it('calculates flat 30%', () => {
    expect(calculateSidoinkomstTax(40000)).toBe(12000)
  })

  it('rounds to 2 decimal places', () => {
    expect(calculateSidoinkomstTax(33333)).toBe(9999.90)
  })
})

describe('fetchTaxTableRates fallback behavior', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    clearTaxTableCache()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearTaxTableCache()
  })

  it("falls back to local data when the Skatteverket API fails for a supported year", async () => {
    // Mock fetch to simulate API outage
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const result = await fetchTaxTableRates(2026, 33, 1)

    expect(result.source).toBe('fallback')
    expect(result.rates.length).toBeGreaterThan(0)
    // Every rate should match the requested table/column/year
    for (const r of result.rates) {
      expect(r.tableYear).toBe(2026)
      expect(r.tableNumber).toBe(33)
      expect(r.columnNumber).toBe(1)
    }
  })

  it('marks source as api when the API returns data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        resultCount: 1,
        results: [
          {
            'år': '2026',
            'tabellnr': '33',
            'inkomst fr.o.m.': '20001',
            'inkomst t.o.m.': '20100',
            'kolumn 1': '2800',
            'kolumn 2': '0',
            'kolumn 3': '2500',
            'kolumn 4': '100',
            'kolumn 5': '2800',
            'kolumn 6': '3000',
          },
        ],
      }),
    } as Response)

    const result = await fetchTaxTableRates(2026, 33, 1)

    expect(result.source).toBe('api')
    expect(result.rates[0].taxAmount).toBe(2800)
  })

  it('throws TaxTableUnavailableError when API fails and year has no fallback', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    await expect(fetchTaxTableRates(2020, 33, 1)).rejects.toBeInstanceOf(TaxTableUnavailableError)
    await expect(fetchTaxTableRates(2020, 33, 1)).rejects.toThrow(/2020/)
  })

  it('caches the fallback result so repeat calls do not re-trigger the failed API', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'))
    globalThis.fetch = fetchSpy

    await fetchTaxTableRates(2026, 33, 1)
    await fetchTaxTableRates(2026, 33, 1)

    // Only one API attempt despite two calls: second hit the cache
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('fetchKommunTaxRates', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function row(kommun: string, rate: string) {
    return { kommun, 'summa, exkl. kyrkoavgift': rate }
  }

  it('pages through every församling row and dedupes to one entry per kommun', async () => {
    // The dataset returns one row per församling. Page 1 is full (so the loop
    // continues); page 2 is short (so it stops). Göteborg only appears on page 2:
    // the bug this guards against was a single 500-row page dropping it.
    const page1 = Array.from({ length: 500 }, () => row('STOCKHOLM', '30.62'))
    const page2 = [
      row('GÖTEBORG', '32.892'),
      row('GÖTEBORG', '33.50'), // duplicate församling: must not override the first
      row('UPPLANDS VÄSBY', '32.042'),
    ]

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ resultCount: 503, results: page1 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ resultCount: 503, results: page2 }) } as Response)
    globalThis.fetch = fetchSpy

    const result = await fetchKommunTaxRates(2026)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // Second call must advance the offset past the first page.
    expect((fetchSpy.mock.calls[1][0] as string)).toContain('_offset=500')

    const goteborg = result.find((r) => r.kommun === 'Göteborg')
    expect(goteborg).toBeDefined()
    expect(goteborg!.totalRate).toBe(32.892)
    expect(goteborg!.tableNumber).toBe(33) // 32.892 → round → 33

    // Deduped: Stockholm appears once despite 500 rows.
    expect(result.filter((r) => r.kommun === 'Stockholm')).toHaveLength(1)
    expect(result.find((r) => r.kommun === 'Stockholm')!.tableNumber).toBe(31) // 30.62 → 31
  })

  it('normalizes Skatteverket uppercase names to title case', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resultCount: 2, results: [row('UPPLANDS VÄSBY', '32.042'), row('MALMÖ', '32.10')] }),
    } as Response)
    globalThis.fetch = fetchSpy

    const result = await fetchKommunTaxRates(2026)
    const names = result.map((r) => r.kommun)

    expect(names).toContain('Upplands Väsby')
    expect(names).toContain('Malmö')
  })

  it('throws when the API returns a non-ok status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 } as Response)
    await expect(fetchKommunTaxRates(2026)).rejects.toThrow(/502/)
  })
})
