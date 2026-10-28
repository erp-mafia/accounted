/**
 * A received self-billing invoice is costed with the same öre rule as an
 * invoice we issue (buildInvoiceWriteData): whole-öre line nets and rounded
 * header sums, so a three-decimal unit price cannot store a total a fraction
 * of an öre off (agent feedback seq 965009).
 */
import { describe, it, expect } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { resolveSelfBilledSaleDraft } from '../self-billed-sale'

describe('resolveSelfBilledSaleDraft amounts', () => {
  it('stores öre-exact line and header amounts for a three-decimal unit price', async () => {
    const { supabase } = createTableMockSupabase({
      customers: {
        data: { id: 'cust-1', name: 'Testkund AB', customer_type: 'swedish_business', vat_number_validated: null, country: 'SE' },
      },
    })

    const result = await resolveSelfBilledSaleDraft(supabase as never, 'company-1', {
      customer_id: 'cust-1',
      external_invoice_number: 'SB-1',
      invoice_date: '2026-05-12',
      received_date: '2026-05-13',
      due_date: '2026-06-11',
      currency: 'SEK',
      items: [{ description: 'Tredecimalt pris', quantity: 3, unit: 'st', unit_price: 33.333, vat_rate: 25 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.draft.items[0]).toMatchObject({ line_total: 100, vat_amount: 25 })
    expect(result.draft.subtotal).toBe(100)
    expect(result.draft.vatAmount).toBe(25)
    expect(result.draft.total).toBe(125)
  })

  // Received self-bills compute VAT on the summed base
  // per rate (netto 7 868,80 gives 1 967,20); line by line it came to 1 967,21.
  const customers = {
    data: { id: 'cust-1', name: 'Aire AB', customer_type: 'swedish_business', vat_number_validated: null, country: 'SE' },
  }
  const base = {
    customer_id: 'cust-1',
    external_invoice_number: 'S2263',
    invoice_date: '2026-07-09',
    received_date: '2026-07-10',
    due_date: '2026-08-08',
    currency: 'SEK',
  }
  // 0,02 x 25 % rounds up on each of three lines: 0,015 per line, 0,045 on the sum.
  const lines = [
    { description: 'Day-ahead', quantity: 1, unit: 'st', unit_price: 7000.02, vat_rate: 25 as const },
    { description: 'Stödtjänst', quantity: 1, unit: 'st', unit_price: 1000.02, vat_rate: 25 as const },
    { description: 'Minimiavgift', quantity: 1, unit: 'st', unit_price: -131.24, vat_rate: 25 as const },
  ]

  it('books the VAT on the summed base per rate, the receivable the customer will pay', async () => {
    const { supabase } = createTableMockSupabase({ customers })
    const result = await resolveSelfBilledSaleDraft(supabase as never, 'company-1', { ...base, items: lines })

    if (!result.ok) throw new Error(JSON.stringify(result.failure))
    expect(result.draft.subtotal).toBe(7868.8)
    expect(result.draft.vatAmount).toBe(1967.2)
    expect(result.draft.total).toBe(9836)
    const lineVat = result.draft.items.reduce((sum, item) => sum + item.vat_amount, 0)
    expect(Math.round(lineVat * 100)).toBe(196720)
  })

  it('books the VAT the document states when it fits, and refuses one that does not', async () => {
    const { supabase } = createTableMockSupabase({ customers })
    const stated = await resolveSelfBilledSaleDraft(supabase as never, 'company-1', {
      ...base,
      items: lines,
      vat_breakdown: [{ vat_rate: 25, vat_amount: 1967.21 }],
    })
    if (!stated.ok) throw new Error(JSON.stringify(stated.failure))
    expect(stated.draft.vatAmount).toBe(1967.21)

    const refused = await resolveSelfBilledSaleDraft(supabase as never, 'company-1', {
      ...base,
      items: lines,
      vat_breakdown: [{ vat_rate: 25, vat_amount: 1980 }],
    })
    expect(refused).toMatchObject({
      ok: false,
      failure: { code: 'vat_breakdown_mismatch', details: { rate: 0.25, reason: 'outside_tolerance' } },
    })
  })
})
