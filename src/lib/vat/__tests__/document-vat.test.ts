import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { allocateDocumentVat, statedVatFromExtraction, statedVatTolerance } from '../document-vat'

const sum = (values: number[]) => roundOre(values.reduce((a, b) => a + b, 0))

function ok(result: ReturnType<typeof allocateDocumentVat>) {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`)
  return result
}

describe('allocateDocumentVat: VAT on the summed base', () => {
  it('SF-CE-202608: 17 564,15 and -2 107,70 at 25 % carry 3 864,11, not 3 864,12 (crm#1367)', () => {
    const result = ok(allocateDocumentVat([
      { lineTotal: 17564.15, rate: 0.25 },
      { lineTotal: -2107.7, rate: 0.25 },
    ]))
    expect(sum(result.lineVat)).toBe(3864.11)
    expect(result.byRate).toEqual([{ rate: 0.25, base: 15456.45, vat: 3864.11, source: 'computed' }])
    // Each line moves at most one öre from its own rounding.
    expect(Math.abs(result.lineVat[0] - roundOre(17564.15 * 0.25))).toBeLessThanOrEqual(0.01)
    expect(Math.abs(result.lineVat[1] - roundOre(-2107.7 * 0.25))).toBeLessThanOrEqual(0.0100001)
  })

  it('120 lines of 9,98 at 25 % carry 299,40 (per line they would carry 300,00)', () => {
    const lines = Array.from({ length: 120 }, () => ({ lineTotal: 9.98, rate: 0.25 }))
    const result = ok(allocateDocumentVat(lines))
    expect(sum(result.lineVat)).toBe(299.4)
    for (const vat of result.lineVat) expect([2.49, 2.5]).toContain(vat)
  })

  it('one line is exactly roundOre(line x rate)', () => {
    for (const [lineTotal, rate] of [[100.02, 0.25], [9.99, 0.12], [10.25, 0.06], [-41.3, 0.25]] as const) {
      const result = ok(allocateDocumentVat([{ lineTotal, rate }]))
      expect(result.lineVat[0]).toBe(roundOre(lineTotal * rate))
    }
  })

  it('rounds exact halves at 12 % and 6 % without float drift', () => {
    // 0,25 x 6 % = 0,015 exactly: half up to 0,02, as roundOre does.
    expect(ok(allocateDocumentVat([{ lineTotal: 0.25, rate: 0.06 }])).lineVat).toEqual([0.02])
    const halves = ok(allocateDocumentVat([
      { lineTotal: 0.125 * 100, rate: 0.12 }, // 12,50 x 12 % = 1,50
      { lineTotal: 10.75, rate: 0.06 }, // 0,645 -> 0,65
      { lineTotal: 10.75, rate: 0.06 }, // sum 21,50 x 6 % = 1,29
    ]))
    expect(halves.byRate).toEqual([
      { rate: 0.12, base: 12.5, vat: 1.5, source: 'computed' },
      { rate: 0.06, base: 21.5, vat: 1.29, source: 'computed' },
    ])
    expect(sum(halves.lineVat.slice(1))).toBe(1.29)
  })

  it('keeps the rates apart and orders them highest first', () => {
    const result = ok(allocateDocumentVat([
      { lineTotal: 100, rate: 0.06 },
      { lineTotal: 200, rate: 0.25 },
      { lineTotal: 50, rate: 0 },
    ]))
    expect(result.byRate.map((r) => [r.rate, r.vat])).toEqual([[0.25, 50], [0.06, 6], [0, 0]])
    expect(result.lineVat).toEqual([6, 50, 0])
  })

  it('a rate with only negative lines carries negative VAT on every line', () => {
    const result = ok(allocateDocumentVat([
      { lineTotal: -4.4, rate: 0.25 },
      { lineTotal: -440.93, rate: 0.25 },
      { lineTotal: -1046.95, rate: 0.25 },
    ]))
    expect(sum(result.lineVat)).toBe(roundOre(-1492.28 * 0.25))
    for (const vat of result.lineVat) expect(vat).toBeLessThan(0)
  })

  it('never moves a line to 0 or across its sign; falls back to per-line when nothing can move', () => {
    // 0,02 x 25 % = 0,005 each. Per line: 0,01 + 0,01; on the sum 0,04 x 25 % = 0,01.
    // Moving either line down would leave it at 0, which reads as "no VAT stored".
    const result = ok(allocateDocumentVat([
      { lineTotal: 0.02, rate: 0.25 },
      { lineTotal: 0.02, rate: 0.25 },
    ]))
    expect(result.lineVat.every((vat) => vat !== 0)).toBe(true)
    expect(result.lineVat).toEqual([0.01, 0.01])
  })

  it('breaks ties deterministically: larger line first, then the earlier one', () => {
    const a = ok(allocateDocumentVat([
      { lineTotal: 0.1, rate: 0.25 }, // 0,025 -> 0,03
      { lineTotal: 0.3, rate: 0.25 }, // 0,075 -> 0,08
      { lineTotal: 0.1, rate: 0.25 }, // 0,025 -> 0,03
    ]))
    // On the sum 0,50 x 25 % = 0,125 -> 0,13; per line 0,14. The larger line gives back the öre.
    expect(a.lineVat).toEqual([0.03, 0.07, 0.03])
    const b = ok(allocateDocumentVat([
      { lineTotal: 0.1, rate: 0.25 },
      { lineTotal: 0.1, rate: 0.25 },
    ]))
    // 0,20 x 25 % = 0,05; per line 0,03 + 0,03: the earlier line gives back the öre.
    expect(b.lineVat).toEqual([0.02, 0.03])
  })
})

describe('allocateDocumentVat: per-line overrides', () => {
  it('keeps an override as given and computes the other lines of the rate on their own base', () => {
    const result = ok(allocateDocumentVat([
      { lineTotal: 1000, rate: 0.25, overrideVat: 120 },
      { lineTotal: 9.98, rate: 0.25 },
      { lineTotal: 9.98, rate: 0.25 },
    ]))
    expect(result.lineVat[0]).toBe(120)
    expect(sum(result.lineVat.slice(1))).toBe(roundOre(19.96 * 0.25))
    expect(result.byRate[0]).toMatchObject({ rate: 0.25, vat: roundOre(120 + 4.99), source: 'computed' })
  })

  it('reports a rate whose every line carries an override as overrides', () => {
    const result = ok(allocateDocumentVat([{ lineTotal: 100, rate: 0.25, overrideVat: 24.99 }]))
    expect(result.byRate).toEqual([{ rate: 0.25, base: 100, vat: 24.99, source: 'overrides' }])
  })
})

describe('allocateDocumentVat: the VAT the document states', () => {
  it('books the stated figure when it is within the per-line rounding of the sum', () => {
    // Per line a seller gets 4 391,04 + -526,92 = 3 864,12: within a 1 öre tolerance of 3 864,11.
    const result = ok(allocateDocumentVat(
      [{ lineTotal: 17564.15, rate: 0.25 }, { lineTotal: -2107.7, rate: 0.25 }],
      [{ rate: 0.25, vatAmount: 3864.12 }],
    ))
    expect(sum(result.lineVat)).toBe(3864.12)
    expect(result.byRate[0]).toMatchObject({ vat: 3864.12, source: 'stated' })
  })

  it('refuses a stated figure outside the tolerance', () => {
    const result = allocateDocumentVat(
      [{ lineTotal: 17564.15, rate: 0.25 }, { lineTotal: -2107.7, rate: 0.25 }],
      [{ rate: 0.25, vatAmount: 3864.2 }],
    )
    expect(result).toEqual({
      ok: false,
      code: 'VAT_BREAKDOWN_MISMATCH',
      details: { rate: 0.25, stated: 3864.2, computed: 3864.11, tolerance: 0.01, reason: 'outside_tolerance' },
    })
  })

  it('accepts the deriving seller\'s per-line total across 120 lines', () => {
    const lines = Array.from({ length: 120 }, () => ({ lineTotal: 9.98, rate: 0.25 }))
    const result = ok(allocateDocumentVat(lines, [{ rate: 0.25, vatAmount: 300 }]))
    expect(sum(result.lineVat)).toBe(300)
    expect(statedVatTolerance(120)).toBe(0.6)
  })

  it('refuses a rate the lines do not carry, a rate it leaves out, and a rate with overrides', () => {
    const lines = [{ lineTotal: 100, rate: 0.25 }, { lineTotal: 100, rate: 0.12 }]
    expect(allocateDocumentVat(lines, [{ rate: 0.06, vatAmount: 6 }, { rate: 0.25, vatAmount: 25 }, { rate: 0.12, vatAmount: 12 }]))
      .toMatchObject({ ok: false, details: { reason: 'rate_not_on_lines', rate: 0.06 } })
    expect(allocateDocumentVat(lines, [{ rate: 0.25, vatAmount: 25 }]))
      .toMatchObject({ ok: false, details: { reason: 'rate_missing', rate: 0.12 } })
    expect(allocateDocumentVat([{ lineTotal: 100, rate: 0.25, overrideVat: 20 }, { lineTotal: 1, rate: 0.25 }], [{ rate: 0.25, vatAmount: 20.25 }]))
      .toMatchObject({ ok: false, details: { reason: 'rate_has_overrides' } })
    expect(allocateDocumentVat(lines, [{ rate: 0.25, vatAmount: 25 }, { rate: 0.25, vatAmount: 25 }, { rate: 0.12, vatAmount: 12 }]))
      .toMatchObject({ ok: false, details: { reason: 'duplicate_rate' } })
  })

  it('accepts a stated 0 % rate only with 0 VAT', () => {
    expect(ok(allocateDocumentVat([{ lineTotal: 100, rate: 0 }], [{ rate: 0, vatAmount: 0 }])).lineVat).toEqual([0])
    expect(allocateDocumentVat([{ lineTotal: 100, rate: 0 }], [{ rate: 0, vatAmount: 1 }]))
      .toMatchObject({ ok: false, details: { reason: 'outside_tolerance' } })
  })
})

describe('statedVatTolerance', () => {
  it('is half an öre per line, at least an öre and at most 2 kr', () => {
    expect(statedVatTolerance(1)).toBe(0.01)
    expect(statedVatTolerance(3)).toBe(0.01)
    expect(statedVatTolerance(4)).toBe(0.02)
    expect(statedVatTolerance(10_000)).toBe(2)
  })
})

describe('statedVatFromExtraction', () => {
  it('reads the breakdown (percent rates) for the rates the lines carry', () => {
    expect(statedVatFromExtraction(
      { vatBreakdown: [{ rate: 25, amount: 250 }, { rate: 12, amount: 12 }] },
      [0.25, 0.12, 0],
    )).toEqual([{ rate: 0.25, vatAmount: 250 }, { rate: 0.12, vatAmount: 12 }])
  })

  it('returns null when the breakdown misses a rate the lines carry', () => {
    expect(statedVatFromExtraction({ vatBreakdown: [{ rate: 25, amount: 250 }] }, [0.25, 0.12])).toBeNull()
  })

  it('falls back to the VAT total when every charged line carries one rate', () => {
    expect(statedVatFromExtraction({ totals: { vatAmount: 3864.11 } }, [0.25, 0.25, 0])).toEqual([{ rate: 0.25, vatAmount: 3864.11 }])
    expect(statedVatFromExtraction({ totals: { vatAmount: 100 } }, [0.25, 0.12])).toBeNull()
    expect(statedVatFromExtraction({ totals: { vatAmount: null } }, [0.25])).toBeNull()
    expect(statedVatFromExtraction(null, [0.25])).toBeNull()
  })
})
