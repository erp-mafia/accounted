import { describe, it, expect } from 'vitest'
import { roundOre, sumOre } from '@/lib/money'
import {
  buildQuotePartLines,
  quotePartNote,
  quotePartTotals,
  resolveQuotePart,
  splitByWeight,
  type QuoteConversion,
  type QuotePartLine,
  type QuoteSourceLine,
} from '../quote-partial-invoice'

// crm#1196: a quote invoiced in parts. The money rules under test: the parts
// sum to the quote to the öre (the last part takes the remainder), VAT is
// computed per line on each part so every rate's base is exact, and a part
// never bills more than what remains.

function line(overrides: Partial<QuoteSourceLine> & { line_total: number }): QuoteSourceLine {
  return {
    sort_order: 0,
    line_type: 'product',
    description: 'Webbprojekt, fast pris',
    quantity: 1,
    unit: 'st',
    unit_price: overrides.line_total,
    discount_percent: 0,
    vat_rate: 25,
    revenue_account: null,
    article_id: null,
    dimensions: {},
    ...overrides,
  }
}

/** A live converted invoice made of the given part lines, as the DB returns it. */
function conversionOf(lines: QuotePartLine[]): QuoteConversion {
  return {
    status: 'sent',
    subtotal: quotePartTotals(lines).subtotal,
    items: lines.map((l) => ({
      line_type: l.line_type,
      line_total: l.line_total,
      vat_rate: l.vat_rate,
      revenue_account: l.revenue_account,
      article_id: l.article_id,
      dimensions: l.dimensions,
    })),
  }
}

/** Invoice a quote part by part, the way convertToInvoice chains them. */
function invoiceInParts(
  quoteLines: QuoteSourceLine[],
  quoteSubtotal: number,
  parts: Array<{ percent: number } | { amount: number } | null>,
): QuotePartLine[][] {
  const conversions: QuoteConversion[] = []
  const invoices: QuotePartLine[][] = []
  for (const part of parts) {
    const resolved = resolveQuotePart({ subtotal: quoteSubtotal }, conversions, part)
    if (!resolved.ok) throw new Error(`refused: ${resolved.code}`)
    const lines = buildQuotePartLines({
      lines: quoteLines,
      amount: resolved.amount,
      rest: resolved.rest,
      conversions,
    })
    invoices.push(lines)
    conversions.push(conversionOf(lines))
  }
  return invoices
}

function netByRate(invoices: QuotePartLine[][]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const lines of invoices) {
    for (const l of lines) {
      if (l.line_type === 'text') continue
      out[l.vat_rate] = sumOre([out[l.vat_rate] ?? 0, l.line_total])
    }
  }
  return out
}

describe('resolveQuotePart', () => {
  it('bills everything not yet invoiced when no part is given', () => {
    const first = resolveQuotePart({ subtotal: 25000 }, [], null)
    expect(first).toMatchObject({ ok: true, amount: 25000, rest: true })

    const afterHalf = resolveQuotePart({ subtotal: 25000 }, [{ status: 'sent', subtotal: 12500 }], null)
    expect(afterHalf).toMatchObject({ ok: true, amount: 12500, rest: true })
  })

  it('reads a percent as a share of the quote, not of what remains', () => {
    const first = resolveQuotePart({ subtotal: 25000 }, [], { percent: 50 })
    expect(first).toMatchObject({ ok: true, amount: 12500, rest: false })
    const second = resolveQuotePart({ subtotal: 25000 }, [{ status: 'sent', subtotal: 12500 }], { percent: 50 })
    expect(second).toMatchObject({ ok: true, amount: 12500, rest: true })
  })

  it('treats a part within rounding of the remainder as the remainder (30/30/40 of 100,01)', () => {
    const conversions = [
      { status: 'sent', subtotal: 30 },
      { status: 'sent', subtotal: 30 },
    ]
    // 40 % of 100,01 is 40,004 -> 40,00, but 40,01 remains: the last part takes it.
    expect(resolveQuotePart({ subtotal: 100.01 }, conversions, { percent: 40 })).toMatchObject({
      ok: true,
      amount: 40.01,
      rest: true,
    })
    // 50 % of 999,99 rounds up to 500,00 twice; the second takes the 499,99 left.
    expect(resolveQuotePart({ subtotal: 999.99 }, [{ status: 'sent', subtotal: 500 }], { percent: 50 })).toMatchObject({
      ok: true,
      amount: 499.99,
      rest: true,
    })
  })

  it('refuses a part above what remains, with the progress to explain it', () => {
    const resolved = resolveQuotePart({ subtotal: 25000 }, [{ status: 'sent', subtotal: 12500 }], { percent: 60 })
    expect(resolved).toMatchObject({ ok: false, code: 'INVOICE_QUOTE_PART_OUT_OF_RANGE', requested: 15000 })
    if (!resolved.ok) expect(resolved.progress).toMatchObject({ invoiced: 12500, remaining: 12500 })

    expect(resolveQuotePart({ subtotal: 25000 }, [], { amount: 30000 })).toMatchObject({
      ok: false,
      code: 'INVOICE_QUOTE_PART_OUT_OF_RANGE',
    })
    // A part that rounds to nothing is not a part.
    expect(resolveQuotePart({ subtotal: 25000 }, [], { amount: 0.001 })).toMatchObject({
      ok: false,
      code: 'INVOICE_QUOTE_PART_OUT_OF_RANGE',
    })
  })

  it('refuses any conversion of a fully invoiced quote and frees a cancelled part again', () => {
    const full = [
      { status: 'sent', subtotal: 12500 },
      { status: 'paid', subtotal: 12500 },
    ]
    expect(resolveQuotePart({ subtotal: 25000 }, full, null)).toMatchObject({ ok: false, code: 'INVOICE_QUOTE_ALREADY_INVOICED' })
    expect(resolveQuotePart({ subtotal: 25000 }, full, { amount: 1 })).toMatchObject({ ok: false, code: 'INVOICE_QUOTE_ALREADY_INVOICED' })

    const oneCancelled = [
      { status: 'sent', subtotal: 12500 },
      { status: 'cancelled', subtotal: 12500 },
    ]
    expect(resolveQuotePart({ subtotal: 25000 }, oneCancelled, null)).toMatchObject({ ok: true, amount: 12500, rest: true })
  })

  it('counts an edited-down whole conversion as a part (the crm#1196 quote)', () => {
    // Converted whole, then edited to 12 500 before it was sent.
    expect(resolveQuotePart({ subtotal: 25000 }, [{ status: 'sent', subtotal: 12500 }], null)).toMatchObject({
      ok: true,
      amount: 12500,
      rest: true,
    })
  })
})

describe('buildQuotePartLines', () => {
  it('bills 50/50 of a one-line fixed-price quote as one unit at the share, VAT per line', () => {
    const quote = [line({ line_total: 25000 })]
    const [first, second] = invoiceInParts(quote, 25000, [{ percent: 50 }, null])

    expect(first).toEqual([
      expect.objectContaining({
        line_type: 'product',
        description: 'Webbprojekt, fast pris',
        quantity: 1,
        unit: 'st',
        unit_price: 12500,
        discount_percent: 0,
        line_total: 12500,
        vat_rate: 25,
        vat_amount: 3125,
      }),
    ])
    expect(quotePartTotals(first)).toEqual({ subtotal: 12500, vat_amount: 3125, total: 15625 })
    expect(quotePartTotals(second)).toEqual({ subtotal: 12500, vat_amount: 3125, total: 15625 })
  })

  it('sums 30/30/40 to the quote to the öre, per line', () => {
    const quote = [
      line({ sort_order: 0, description: 'Design', line_total: 333.33 }),
      line({ sort_order: 1, description: 'Utveckling', line_total: 666.67, revenue_account: '3041' }),
    ]
    const invoices = invoiceInParts(quote, 1000, [{ percent: 30 }, { percent: 30 }, { percent: 40 }])

    expect(invoices.map((lines) => quotePartTotals(lines).subtotal)).toEqual([300, 300, 400])
    const design = sumOre(invoices.flatMap((lines) => lines.filter((l) => l.description === 'Design').map((l) => l.line_total)))
    const dev = sumOre(invoices.flatMap((lines) => lines.filter((l) => l.description === 'Utveckling').map((l) => l.line_total)))
    expect(design).toBe(333.33)
    expect(dev).toBe(666.67)
  })

  it('keeps each VAT rate exact over the parts of a mixed-rate quote', () => {
    const quote = [
      line({ sort_order: 0, description: 'Konsulttid', line_total: 10000.01, vat_rate: 25 }),
      line({ sort_order: 1, description: 'Kurslitteratur', line_total: 1999.99, vat_rate: 6 }),
      line({ sort_order: 2, description: 'Lunch', line_total: 333.33, vat_rate: 12 }),
    ]
    const subtotal = 12333.33
    const invoices = invoiceInParts(quote, subtotal, [{ percent: 33.33 }, { amount: 4000 }, null])

    expect(sumOre(invoices.map((lines) => quotePartTotals(lines).subtotal))).toBe(subtotal)
    expect(netByRate(invoices)).toEqual({ 25: 10000.01, 6: 1999.99, 12: 333.33 })
    for (const lines of invoices) {
      for (const l of lines) {
        // VAT on each part line is the rate on that line's own base.
        expect(l.vat_amount).toBe(roundOre((l.line_total * l.vat_rate) / 100))
      }
    }
  })

  it('splits a discount line in proportion and keeps it off the books of other lines', () => {
    const quote = [
      line({ sort_order: 0, description: 'Arbete', line_total: 10000 }),
      line({ sort_order: 1, description: 'Rabatt', line_total: -1000, revenue_account: '3731' }),
    ]
    const [first, second] = invoiceInParts(quote, 9000, [{ percent: 50 }, null])

    expect(first.map((l) => [l.description, l.line_total])).toEqual([
      ['Arbete', 5000],
      ['Rabatt', -500],
    ])
    expect(second.map((l) => [l.description, l.line_total, l.revenue_account])).toEqual([
      ['Arbete', 5000, null],
      ['Rabatt', -500, '3731'],
    ])
  })

  it('keeps text lines in place and drops a product line whose share is zero', () => {
    const quote = [
      line({ sort_order: 0, line_type: 'text', description: 'Etapp 1', line_total: 0 }),
      line({ sort_order: 1, description: 'Arbete', line_total: 1000 }),
      line({ sort_order: 2, description: 'Gratis uppstartsmöte', line_total: 0 }),
    ]
    const [lines] = invoiceInParts(quote, 1000, [{ percent: 50 }])
    expect(lines.map((l) => [l.sort_order, l.line_type, l.description])).toEqual([
      [0, 'text', 'Etapp 1'],
      [1, 'product', 'Arbete'],
    ])
  })

  it('carries article, revenue account and dimensions on each part line', () => {
    const quote = [
      line({ line_total: 2000, article_id: 'art-1', article_number: 'A-100', revenue_account: '3041', dimensions: { '6': 'P1' } }),
    ]
    const [lines] = invoiceInParts(quote, 2000, [{ amount: 500 }])
    // The article number the quote printed stays frozen on each part (crm#1084).
    expect(lines[0]).toMatchObject({ article_id: 'art-1', article_number: 'A-100', revenue_account: '3041', dimensions: { '6': 'P1' }, line_total: 500 })
  })

  it('splits the rest in proportion when an earlier invoice was edited onto a rate the quote lacks', () => {
    const quote = [line({ line_total: 1000 })]
    const edited: QuoteConversion = {
      status: 'sent',
      subtotal: 400,
      items: [{ line_type: 'product', line_total: 400, vat_rate: 12, revenue_account: null, article_id: null, dimensions: {} }],
    }
    const resolved = resolveQuotePart({ subtotal: 1000 }, [edited], null)
    expect(resolved).toMatchObject({ ok: true, amount: 600, rest: true })
    if (!resolved.ok) return
    const lines = buildQuotePartLines({ lines: quote, amount: resolved.amount, rest: true, conversions: [edited] })
    expect(quotePartTotals(lines).subtotal).toBe(600)
  })
})

describe('splitByWeight', () => {
  it('sums exactly and puts the rounding on the heaviest weight (the first of equals)', () => {
    expect(splitByWeight(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33])
    expect(splitByWeight(100, [1, 2, 1])).toEqual([25, 50, 25])
    expect(sumOre(splitByWeight(0.05, [3, 3, 3]))).toBe(0.05)
    expect(splitByWeight(10, [0, 0])).toEqual([10, 0])
  })
})

describe('quotePartNote', () => {
  it('names the quote, the part and what came before, in the document language', () => {
    expect(
      quotePartNote({ language: 'sv', quoteNumber: 'OF-012', quoteSubtotal: 25000, amount: 12500, invoicedBefore: 0, currency: 'SEK' }),
    ).toBe('Delfakturering av offert OF-012: 12 500,00 av 25 000,00 SEK exkl. moms (50 %).')
    expect(
      quotePartNote({ language: 'en', quoteNumber: 'OF-012', quoteSubtotal: 25000, amount: 12500, invoicedBefore: 12500, currency: 'SEK' }),
    ).toBe('Partial invoice of quote OF-012: 12,500.00 of 25,000.00 SEK excl. VAT (50%). Previously invoiced: 12,500.00 SEK.')
  })
})
