import { describe, it, expect } from 'vitest'
import { deriveVatLinesFromBreakdown } from '../vat-breakdown-lines'

// The invoice this was written against: a real Telenor bill sitting in the
// document inbox. Two itemised lines with no rate, and a breakdown saying 928
// kr of the net is VAT-free. Before the fix the staging path summed the line
// VAT to 0 and dropped 776.99 kr of deductible ingående moms.
const TELENOR = {
  subtotal: 4035.96,
  documentVat: 776.99,
  breakdown: [
    { base: 3107.96, rate: 25, amount: 776.99 },
    { base: 928, rate: 0, amount: 0 },
  ],
}

const silent = { linesStateVat: false, deductsInputVat: true }

describe('deriveVatLinesFromBreakdown', () => {
  it('rebuilds a mixed-rate invoice into one line per VAT base', () => {
    const out = deriveVatLinesFromBreakdown({ ...silent, ...TELENOR })
    expect(out.status).toBe('rebuilt')
    if (out.status !== 'rebuilt') return

    expect(out.lines).toEqual([
      { description: 'Underlag 25 % moms', quantity: 1, unitPrice: 3107.96, lineTotal: 3107.96, vatRate: 25, vatAmount: 776.99 },
      { description: 'Underlag utan moms', quantity: 1, unitPrice: 928, lineTotal: 928, vatRate: 0, vatAmount: 0 },
    ])

    // Both partitions must agree with the document, or the staged invoice
    // would not balance against the underlag it came from.
    expect(out.lines.reduce((s, l) => s + l.lineTotal, 0)).toBeCloseTo(TELENOR.subtotal, 2)
    expect(out.lines.reduce((s, l) => s + l.vatAmount, 0)).toBeCloseTo(TELENOR.documentVat, 2)
  })

  // A stated rate is an answer, including zero: an exempt pension premium
  // says 0 and means it. Overriding that would be the same bug mirrored.
  it('never overrides lines that state their own VAT, zero included', () => {
    const out = deriveVatLinesFromBreakdown({ ...TELENOR, linesStateVat: true, deductsInputVat: true })
    expect(out.status).toBe('not_applicable')
  })

  it('does nothing when the document charges no VAT', () => {
    const out = deriveVatLinesFromBreakdown({ ...silent, subtotal: 1000, documentVat: 0, breakdown: [] })
    expect(out.status).toBe('not_applicable')
  })

  it('stays out of the way under reverse charge, exempt and export', () => {
    const out = deriveVatLinesFromBreakdown({ ...TELENOR, linesStateVat: false, deductsInputVat: false })
    expect(out.status).toBe('not_applicable')
  })

  // The common single-rate case: the itemisation is right, it only lacked a
  // rate, so descriptions and accounts must survive.
  it('keeps the itemised lines when one rate covers the whole net', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 1000,
      documentVat: 250,
      breakdown: [{ base: 1000, rate: 25, amount: 250 }],
    })
    expect(out).toEqual({ status: 'uniform_rate', rate: 25 })
  })

  it('derives the rate from the totals when there is no breakdown at all', () => {
    for (const [subtotal, vat, rate] of [[1000, 250, 25], [1000, 120, 12], [1000, 60, 6]] as const) {
      const out = deriveVatLinesFromBreakdown({ ...silent, subtotal, documentVat: vat, breakdown: undefined })
      expect(out).toEqual({ status: 'uniform_rate', rate })
    }
  })

  // The safety net. Each of these used to stage vat_amount: 0 in silence.
  it('refuses when the charged VAT matches no Swedish rate and nothing explains it', () => {
    const out = deriveVatLinesFromBreakdown({ ...silent, subtotal: 1000, documentVat: 190, breakdown: null })
    expect(out.status).toBe('unreconciled')
  })

  it('refuses a malformed breakdown rather than guessing', () => {
    for (const breakdown of ['nonsense', [{ base: 1 }], [null]]) {
      const out = deriveVatLinesFromBreakdown({ ...silent, subtotal: 4035.96, documentVat: 776.99, breakdown })
      expect(out.status).toBe('unreconciled')
    }
  })

  it('refuses when the breakdown VAT does not match the document VAT', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 4035.96,
      documentVat: 776.99,
      breakdown: [{ base: 3107.96, rate: 25, amount: 700 }],
    })
    expect(out.status).toBe('unreconciled')
    if (out.status === 'unreconciled') expect(out.reason).toContain('776.99')
  })

  it('refuses when the bases do not add up to the subtotal', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 4035.96,
      documentVat: 776.99,
      breakdown: [{ base: 3107.96, rate: 25, amount: 776.99 }],
    })
    expect(out.status).toBe('unreconciled')
    if (out.status === 'unreconciled') expect(out.reason).toContain('subtotal')
  })

  it('refuses a foreign VAT rate rather than silently zeroing it', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 1000,
      documentVat: 190,
      breakdown: [{ base: 1000, rate: 19, amount: 190 }],
    })
    expect(out.status).toBe('unreconciled')
    if (out.status === 'unreconciled') expect(out.reason).toContain('19')
  })

  it('refuses a row whose amount contradicts its own rate', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 1000,
      documentVat: 200,
      breakdown: [{ base: 1000, rate: 25, amount: 200 }],
    })
    expect(out.status).toBe('unreconciled')
  })

  it('drops an all-zero breakdown row instead of staging an empty line', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 1000,
      documentVat: 250,
      breakdown: [
        { base: 1000, rate: 25, amount: 250 },
        { base: 0, rate: 0, amount: 0 },
      ],
    })
    // One surviving row covering the whole net is the uniform case.
    expect(out).toEqual({ status: 'uniform_rate', rate: 25 })
  })

  it('tolerates one öre of the document’s own rounding', () => {
    const out = deriveVatLinesFromBreakdown({
      ...silent,
      subtotal: 4035.96,
      documentVat: 776.99,
      breakdown: [
        { base: 3107.96, rate: 25, amount: 777 },
        { base: 928, rate: 0, amount: 0 },
      ],
    })
    expect(out.status).toBe('rebuilt')
  })
})
