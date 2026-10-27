import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { invoiceAmountToPayFields, withAmountToPay } from '@/lib/invoices/amount-to-pay-fields'

/** A client whose company_settings read answers `result`; counts the reads. */
function settingsClient(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const chain = { select: () => chain, eq: () => chain, maybeSingle }
  const from = vi.fn().mockReturnValue(chain)
  return { client: { from } as unknown as SupabaseClient, from }
}

describe('invoiceAmountToPayFields (crm#1487)', () => {
  it("follows the invoice's own choice, not the company's", () => {
    expect(invoiceAmountToPayFields({ total: 4.38, currency: 'SEK', ore_rounding: false }, { ore_rounding: true }))
      .toEqual({ amount_to_pay: 4.38, ore_rounding_amount: 0 })
    expect(invoiceAmountToPayFields({ total: 4.38, currency: 'SEK', ore_rounding: true }, { ore_rounding: false }))
      .toEqual({ amount_to_pay: 4, ore_rounding_amount: -0.38 })
  })

  it('mirrors the original on a credit note', () => {
    expect(
      invoiceAmountToPayFields({ total: -4.38, currency: 'SEK', ore_rounding: true, credited_invoice_id: 'inv-1' }, null),
    ).toEqual({ amount_to_pay: -4, ore_rounding_amount: 0.38 })
  })

  it('takes the ROT/RUT deduction off after rounding', () => {
    expect(
      invoiceAmountToPayFields({ total: 1000.4, currency: 'SEK', ore_rounding: true, deduction_total: 300 }, null),
    ).toEqual({ amount_to_pay: 700, ore_rounding_amount: -0.4 })
  })

  it('never rounds a foreign-currency invoice', () => {
    expect(invoiceAmountToPayFields({ total: 4.38, currency: 'EUR', ore_rounding: true }, null))
      .toEqual({ amount_to_pay: 4.38, ore_rounding_amount: 0 })
  })
})

describe('withAmountToPay', () => {
  it('does not read the company setting when every row has its own choice', async () => {
    const { client, from } = settingsClient({ data: { ore_rounding: true }, error: null })
    const rows = await withAmountToPay(client, 'co-1', [{ id: 'a', total: 4.38, currency: 'SEK', ore_rounding: false }])
    expect(from).not.toHaveBeenCalled()
    expect(rows).toEqual([{ id: 'a', total: 4.38, currency: 'SEK', ore_rounding: false, amount_to_pay: 4.38, ore_rounding_amount: 0 }])
  })

  it("computes a draft without a choice with the company's setting, on by default", async () => {
    const off = settingsClient({ data: { ore_rounding: false }, error: null })
    const [draft] = await withAmountToPay(off.client, 'co-1', [{ total: 4.38, currency: 'SEK', ore_rounding: null }])
    expect(off.from).toHaveBeenCalledWith('company_settings')
    expect(draft.amount_to_pay).toBe(4.38)

    const none = settingsClient({ data: null, error: null })
    const [inherited] = await withAmountToPay(none.client, 'co-1', [{ total: 4.38, currency: 'SEK', ore_rounding: null }])
    expect(inherited.amount_to_pay).toBe(4)
  })

  it('throws instead of guessing when the company setting cannot be read', async () => {
    const { client } = settingsClient({ data: null, error: { message: 'boom' } })
    await expect(withAmountToPay(client, 'co-1', [{ total: 4.38, currency: 'SEK', ore_rounding: null }])).rejects.toThrow(
      /company_settings/,
    )
  })
})
