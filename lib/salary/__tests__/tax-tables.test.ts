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
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 0, incomeTo: 2200, kind: 'amount', taxAmount: 0 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 2201, incomeTo: 20000, kind: 'amount', taxAmount: 2800 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 20001, incomeTo: 30000, kind: 'amount', taxAmount: 5600 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 30001, incomeTo: 40000, kind: 'amount', taxAmount: 8900 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 40001, incomeTo: 50000, kind: 'amount', taxAmount: 12500 },
  { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 50001, incomeTo: 60000, kind: 'amount', taxAmount: 16800 },
]

// Mirrors the real structure of table 31 for 2026: krona brackets up to
// 80 000 kr/month, percent-of-income brackets above, open-ended top row.
const table31Rates: TaxTableRate[] = [
  { tableYear: 2026, tableNumber: 31, columnNumber: 1, incomeFrom: 0, incomeTo: 79800, kind: 'amount', taxAmount: 25192 },
  { tableYear: 2026, tableNumber: 31, columnNumber: 1, incomeFrom: 79801, incomeTo: 80000, kind: 'amount', taxAmount: 25294 },
  { tableYear: 2026, tableNumber: 31, columnNumber: 1, incomeFrom: 80001, incomeTo: 80600, kind: 'percent', taxPercent: 32 },
  { tableYear: 2026, tableNumber: 31, columnNumber: 1, incomeFrom: 80601, incomeTo: 99800, kind: 'percent', taxPercent: 34 },
  { tableYear: 2026, tableNumber: 31, columnNumber: 1, incomeFrom: 99801, incomeTo: 100000, kind: 'percent', taxPercent: 35 },
  { tableYear: 2026, tableNumber: 31, columnNumber: 1, incomeFrom: 100001, incomeTo: 9999999, kind: 'percent', taxPercent: 50 },
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

  it('applies percent of the whole income above the last krona bracket (reported bug: 100 000 kr, tabell 31 kol 1)', () => {
    expect(lookupTaxAmount(31, 1, 100000, table31Rates)).toBe(35000)
  })

  it('switches from krona amount to percent exactly at the 80 000/80 001 boundary', () => {
    expect(lookupTaxAmount(31, 1, 80000, table31Rates)).toBe(25294)
    // 80 001 × 32 % = 25 600.32 → öre dropped (SFF 22 kap. 1 §)
    expect(lookupTaxAmount(31, 1, 80001, table31Rates)).toBe(25600)
  })

  it('drops öre when the percent of income is not a whole krona amount', () => {
    // 80 123 × 32 % = 25 639.36 → 25 639
    expect(lookupTaxAmount(31, 1, 80123, table31Rates)).toBe(25639)
  })

  it('applies the open-ended top percent bracket to arbitrarily high incomes', () => {
    expect(lookupTaxAmount(31, 1, 2000000, table31Rates)).toBe(1000000)
  })

  it('clamps to the last loaded bracket only as a last resort when percent rows are missing', () => {
    // sampleRates has no percent rows: legacy guard keeps withholding non-zero
    expect(lookupTaxAmount(33, 1, 100000, sampleRates)).toBe(16800)
  })

  it('throws TaxTableUnavailableError when no matching rates exist (no silent 30% fallback)', () => {
    expect(() => lookupTaxAmount(99, 1, 40000, sampleRates)).toThrow(TaxTableUnavailableError)
    expect(() => lookupTaxAmount(99, 1, 40000, sampleRates)).toThrow(/table 99/)
  })

  it('throws when the loaded brackets have a gap instead of silently withholding 0', () => {
    const gappyRates: TaxTableRate[] = [
      { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 1, incomeTo: 20000, kind: 'amount', taxAmount: 2800 },
      // gap: 20001-29999 missing (e.g. partial API data)
      { tableYear: 2026, tableNumber: 33, columnNumber: 1, incomeFrom: 30000, incomeTo: 9999999, kind: 'percent', taxPercent: 35 },
    ]
    expect(() => lookupTaxAmount(33, 1, 25000, gappyRates)).toThrow(TaxTableUnavailableError)
    expect(() => lookupTaxAmount(33, 1, 25000, gappyRates)).toThrow(/gap/)
    // Below the first bracket is not a gap: no withholding due
    expect(lookupTaxAmount(33, 1, 0, gappyRates)).toBe(0)
  })

  it('filters by correct column', () => {
    const rates: TaxTableRate[] = [
      ...sampleRates,
      { tableYear: 2026, tableNumber: 33, columnNumber: 2, incomeFrom: 0, incomeTo: 50000, kind: 'amount', taxAmount: 999 },
    ]
    expect(lookupTaxAmount(33, 2, 30000, rates)).toBe(999)
  })
})

describe('calculateJamkningTax', () => {
  it('calculates tax using custom percentage', () => {
    expect(calculateJamkningTax(40000, 20)).toBe(8000)
  })

  it('drops öre so the withheld amount is whole kronor (SFF 22 kap. 1 §)', () => {
    // 33 333 × 15.5 % = 5 166.615 → 5 166, not 5 166.62
    expect(calculateJamkningTax(33333, 15.5)).toBe(5166)
    // 41 999.99 × 25 % = 10 499.9975 → 10 499: öre are dropped, never rounded up
    expect(calculateJamkningTax(41999.99, 25)).toBe(10499)
  })

  it('is immune to float noise on exact-krona results', () => {
    // 1000 × 0.007 === 6.999999999999999 in floats: a naive Math.floor on the
    // raw product would withhold 6 kr where the exact result is 7 kr
    expect(calculateJamkningTax(1000, 0.7)).toBe(7)
    expect(calculateJamkningTax(5000, 0.7)).toBe(35)
  })

  it('truncates toward zero for negative taxable income (skeptic refutation case)', () => {
    // Deductions exceeding pay make taxable income negative; dropping öre
    // truncates toward zero, so Math.floor (which would give -543 and -1
    // here) must not add an extra negative krona
    expect(calculateJamkningTax(-3500.25, 15.5)).toBe(-542)
    expect(calculateSidoinkomstTax(-100.01)).toBe(-30)
    expect(calculateSidoinkomstTax(-0.01)).toBe(0)
  })
})

describe('calculateSidoinkomstTax', () => {
  it('calculates flat 30%', () => {
    expect(calculateSidoinkomstTax(40000)).toBe(12000)
  })

  it('drops öre so the withheld amount is whole kronor (SFF 22 kap. 1 §)', () => {
    // 33 333 × 30 % = 9 999.90 → 9 999, not 9 999.90
    expect(calculateSidoinkomstTax(33333)).toBe(9999)
    // 30 123.45 × 30 % = 9 037.035 → 9 037
    expect(calculateSidoinkomstTax(30123.45)).toBe(9037)
  })

  it('returns exact whole kronor when the product is a whole-krona amount', () => {
    expect(calculateSidoinkomstTax(41300)).toBe(12390)
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
    // Both sections must be present: krona brackets and percent brackets
    expect(result.rates.some((r) => r.kind === 'amount')).toBe(true)
    expect(result.rates.some((r) => r.kind === 'percent')).toBe(true)
  })

  it('resolves the reported bug through the fallback data: 100 000 kr, tabell 31 kol 1 → 35 000 kr', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))

    const result = await fetchTaxTableRates(2026, 31, 1)

    expect(result.source).toBe('fallback')
    expect(lookupTaxAmount(31, 1, 100000, result.rates)).toBe(35000)
    // Last krona bracket still applies at 80 000 (the pre-fix clamp value)
    expect(lookupTaxAmount(31, 1, 80000, result.rates)).toBe(25294)
  })

  function apiRow(from: string, to: string, col1: string) {
    return {
      'år': '2026',
      'tabellnr': '33',
      'inkomst fr.o.m.': from,
      'inkomst t.o.m.': to,
      'kolumn 1': col1,
      'kolumn 2': '0',
      'kolumn 3': '2500',
      'kolumn 4': '100',
      'kolumn 5': '2800',
      'kolumn 6': '3000',
    }
  }

  it('marks source as api and combines krona and percent rows when the API returns data', async () => {
    // The B-row and %-row sections are fetched as separate filtered queries
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const isPercentQuery = url.includes(encodeURIComponent('30%'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          resultCount: 1,
          results: isPercentQuery
            ? [apiRow('80001', '', '32')]
            : [apiRow('20001', '20100', '2800')],
        }),
      } as Response
    }) as typeof fetch

    const result = await fetchTaxTableRates(2026, 33, 1)

    expect(result.source).toBe('api')
    expect(result.rates).toContainEqual(
      expect.objectContaining({ kind: 'amount', incomeFrom: 20001, incomeTo: 20100, taxAmount: 2800 })
    )
    // Empty upper bound on the top percent row maps to the open-ended sentinel
    expect(result.rates).toContainEqual(
      expect.objectContaining({ kind: 'percent', incomeFrom: 80001, incomeTo: 9999999, taxPercent: 32 })
    )
  })

  it('falls back when the API serves krona rows but no percent rows', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const isPercentQuery = url.includes(encodeURIComponent('30%'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          resultCount: isPercentQuery ? 0 : 1,
          results: isPercentQuery ? [] : [apiRow('20001', '20100', '2800')],
        }),
      } as Response
    }) as typeof fetch

    const result = await fetchTaxTableRates(2026, 33, 1)

    // Krona rows alone would clamp high incomes: incomplete API data must not win
    expect(result.source).toBe('fallback')
    expect(result.rates.some((r) => r.kind === 'percent')).toBe(true)
  })

  it('falls back when a pagination page fails (no silent gap in the bracket list)', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('_offset=500')) {
        return { ok: false, status: 502 } as Response
      }
      const isPercentQuery = url.includes(encodeURIComponent('30%'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          // First page claims more rows exist, forcing the paginated path
          resultCount: isPercentQuery ? 1 : 600,
          results: isPercentQuery
            ? [apiRow('80001', '', '32')]
            : Array.from({ length: 500 }, (_, i) =>
                apiRow(String(i * 100 + 1), String((i + 1) * 100), '1000')
              ),
        }),
      } as Response
    }) as typeof fetch

    const result = await fetchTaxTableRates(2026, 33, 1)

    expect(result.source).toBe('fallback')
  })

  it('falls back when the API returns a malformed income boundary', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const isPercentQuery = url.includes(encodeURIComponent('30%'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          resultCount: 1,
          results: isPercentQuery
            ? [apiRow('80001', '', '32')]
            // Malformed upper bound on a krona row: parseInt would read 20100
            : [apiRow('20001', '20100abc', '2800')],
        }),
      } as Response
    }) as typeof fetch

    const result = await fetchTaxTableRates(2026, 33, 1)

    expect(result.source).toBe('fallback')
  })

  it('falls back when the API returns a malformed kolumn value instead of storing 0', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      const isPercentQuery = url.includes(encodeURIComponent('30%'))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          resultCount: 1,
          results: isPercentQuery
            ? [apiRow('80001', '', 'N/A')]
            : [apiRow('20001', '20100', '2800')],
        }),
      } as Response
    }) as typeof fetch

    const result = await fetchTaxTableRates(2026, 33, 1)

    expect(result.source).toBe('fallback')
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

    // One API attempt (two section queries: 30B + 30%) despite two calls:
    // the second call hit the cache
    expect(fetchSpy).toHaveBeenCalledTimes(2)
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

  it('picks the lower table at exactly ,50 and the higher from ,51 (Skatteverket rule)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resultCount: 3,
        results: [row('LÅGKÖPING', '32.49'), row('MITTKÖPING', '32.50'), row('HÖGKÖPING', '32.51')],
      }),
    } as Response)
    globalThis.fetch = fetchSpy

    const result = await fetchKommunTaxRates(2026)

    expect(result.find((r) => r.kommun === 'Lågköping')!.tableNumber).toBe(32)
    // Skatteverket's own example: 32,50 belongs to table 32, not 33
    expect(result.find((r) => r.kommun === 'Mittköping')!.tableNumber).toBe(32)
    expect(result.find((r) => r.kommun === 'Högköping')!.tableNumber).toBe(33)
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
