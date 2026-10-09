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
})
