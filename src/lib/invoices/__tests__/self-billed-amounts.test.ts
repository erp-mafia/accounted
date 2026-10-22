/**
 * The amounts of a received self-bill, shared by the registration and the
 * editor's Summering (crm#1367): the screen shows what registering books.
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { selfBilledSaleAmounts } from '../self-billed-amounts'
import { resolveSelfBilledSaleDraft } from '../self-billed-sale'

// Deepgrid's received self-bill: netto 7 868,80 gives moms 1 967,20 on the
// summed base; line by line it came to 1 967,21.
const ITEMS = [
  { quantity: 1, unit_price: 7000.02, vat_rate: 25 },
  { quantity: 1, unit_price: 1000.02, vat_rate: 25 },
  { quantity: 1, unit_price: -131.24, vat_rate: 25 },
]

describe('selfBilledSaleAmounts', () => {
  it('computes the VAT on the summed base per rate and spreads it over the lines', () => {
    const amounts = selfBilledSaleAmounts(ITEMS, 25)
    if (!amounts.ok) throw new Error(JSON.stringify(amounts))
    expect(amounts).toMatchObject({ subtotal: 7868.8, vatAmount: 1967.2, total: 9836 })
    expect(amounts.byRate).toEqual([{ rate: 25, base: 7868.8, vat: 1967.2 }])
    expect(amounts.lines.map((line) => line.vat_rate)).toEqual([25, 25, 25])
  })

  it('takes the customer\'s default rate for a line without one, and keeps the rates apart', () => {
    const amounts = selfBilledSaleAmounts([{ quantity: 2, unit_price: 50 }, { quantity: 1, unit_price: 100, vat_rate: 12 }], 25)
    if (!amounts.ok) throw new Error(JSON.stringify(amounts))
    expect(amounts.byRate).toEqual([
      { rate: 25, base: 100, vat: 25 },
      { rate: 12, base: 100, vat: 12 },
    ])
    expect(amounts.total).toBe(237)
  })

  it('books a stated VAT that fits and refuses one that does not', () => {
    const stated = selfBilledSaleAmounts(ITEMS, 25, [{ vat_rate: 25, vat_amount: 1967.21 }])
    expect(stated).toMatchObject({ ok: true, vatAmount: 1967.21, total: 9836.01 })
    expect(selfBilledSaleAmounts(ITEMS, 25, [{ vat_rate: 25, vat_amount: 1990 }]))
      .toMatchObject({ ok: false, code: 'VAT_BREAKDOWN_MISMATCH', details: { reason: 'outside_tolerance' } })
  })

  it('is what the registration books: the editor and resolveSelfBilledSaleDraft agree to the öre', async () => {
    const { supabase } = createTableMockSupabase({
      customers: {
        data: { id: 'cust-1', name: 'Aire AB', customer_type: 'swedish_business', vat_number_validated: null, country: 'SE' },
      },
    })
    const draft = await resolveSelfBilledSaleDraft(supabase as never, 'company-1', {
      customer_id: 'cust-1',
      external_invoice_number: 'S2263',
      invoice_date: '2026-07-09',
      received_date: '2026-07-10',
      due_date: '2026-08-08',
      currency: 'SEK',
      items: ITEMS.map((item) => ({ ...item, description: 'Rad', unit: 'st' })),
    })
    const editor = selfBilledSaleAmounts(ITEMS, 25)
    if (!draft.ok || !editor.ok) throw new Error('expected both to cost the invoice')
    expect([editor.subtotal, editor.vatAmount, editor.total]).toEqual([draft.draft.subtotal, draft.draft.vatAmount, draft.draft.total])
    expect(editor.lines.map((line) => line.vat_amount)).toEqual(draft.draft.items.map((item) => item.vat_amount))
  })
})
