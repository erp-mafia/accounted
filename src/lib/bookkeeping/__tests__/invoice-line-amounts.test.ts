import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { computeLineAmounts, computeLineNet, computeLineVat, hasLineDiscount } from '@/lib/bookkeeping/invoice-line-amounts'
import { computeDeduction } from '@/lib/bookkeeping/rot-rut-rules'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'

describe('computeLineAmounts', () => {
  it('rounds qty * price to öre when no discount applies', () => {
    // A three-decimal unit price used to store 99.999 as the line net and a
    // header total off by a fraction of an öre (agent feedback seq 965009).
    expect(computeLineAmounts(3, 33.333)).toEqual({ gross: 100, discount: 0, net: 100 })
    expect(computeLineAmounts(7, 14.285)).toEqual({ gross: 100, discount: 0, net: 100 })
    expect(computeLineAmounts(2, 100, null)).toEqual({ gross: 200, discount: 0, net: 200 })
    expect(computeLineAmounts(2, 100, 0)).toEqual({ gross: 200, discount: 0, net: 200 })
  })

  it('computes discount and net in exact ore arithmetic', () => {
    expect(computeLineAmounts(2, 100, 10)).toEqual({ gross: 200, discount: 20, net: 180 })
    // 1 * 99.99 at 33%: gross 99.99, discount round(32.9967) = 33.00, net 66.99.
    expect(computeLineAmounts(1, 99.99, 33)).toEqual({ gross: 99.99, discount: 33, net: 66.99 })
    // gross - discount is always exact: net + discount reconstructs gross.
    const amounts = computeLineAmounts(7, 123.45, 12.5)
    expect(amounts.net + amounts.discount).toBeCloseTo(amounts.gross, 10)
  })

  it('handles a 100% discount as a zero net line', () => {
    expect(computeLineAmounts(4, 250, 100)).toEqual({ gross: 1000, discount: 1000, net: 0 })
    expect(computeLineNet(4, 250, 100)).toBe(0)
  })

  it('hasLineDiscount treats null/undefined/0 as no discount', () => {
    expect(hasLineDiscount(undefined)).toBe(false)
    expect(hasLineDiscount(null)).toBe(false)
    expect(hasLineDiscount(0)).toBe(false)
    expect(hasLineDiscount(0.5)).toBe(true)
  })
})

describe('computeLineVat', () => {
  it('rounds an exact half öre up (crm#1343)', () => {
    // 5713 st x 0,10 kr = 571,30 kr; 25 % of it is exactly 142,825 kr. In
    // binary floating point 571.3 * 25 is 14282.499999999998, which the
    // hand-rolled scale-round-scale form rounded down to 142,82.
    const net = computeLineNet(5713, 0.1)
    expect(net).toBe(571.3)
    expect(computeLineVat(net, 25)).toBe(142.83)
    expect(computeLineVat(38.98, 25)).toBe(9.75)
    expect(computeLineVat(66.82, 25)).toBe(16.71)
  })

  it('computes ordinary lines at every Swedish rate', () => {
    expect(computeLineVat(10000, 25)).toBe(2500)
    expect(computeLineVat(100, 12)).toBe(12)
    expect(computeLineVat(99.99, 6)).toBe(6)
    expect(computeLineVat(99.99, 25)).toBe(25)
    expect(computeLineVat(1500, 0)).toBe(0)
    expect(computeLineVat(0, 25)).toBe(0)
  })

  it('equals exact integer öre arithmetic, half up, for every net up to 2 000 kr', () => {
    for (const rate of [6, 12, 25]) {
      for (let ore = 1; ore <= 200_000; ore++) {
        const expectedOre = Math.floor((ore * rate + 50) / 100)
        const vat = computeLineVat(ore / 100, rate)
        if (vat !== expectedOre / 100) {
          throw new Error(`${ore / 100} kr at ${rate} %: got ${vat}, expected ${expectedOre / 100}`)
        }
      }
    }
  })
})

describe('computeDeduction with a line discount', () => {
  it('deducts on the net line total (what the customer pays)', () => {
    // 10 tim * 1000 = 10 000, 10% rabatt -> 9 000 net, incl VAT 11 250,
    // ROT 30% = 3 375 (vs 3 750 undiscounted).
    expect(
      computeDeduction({
        unit_price: 1000,
        quantity: 10,
        discount_percent: 10,
        deduction_type: 'rot',
        vat_rate: 25,
      }),
    ).toBe(3375)
    expect(
      computeDeduction({ unit_price: 1000, quantity: 10, deduction_type: 'rot', vat_rate: 25 }),
    ).toBe(3750)
  })
})

describe('computeDeduction on a half-öre VAT line', () => {
  it('bases the deduction on the line VAT the invoice stores', () => {
    // 2,30 kr at 25 % is exactly 0,575 kr VAT, stored as 0,58: the RUT base
    // is 2,88 incl. VAT and half of it is 1,44 (it was 1,43 on 0,57).
    expect(computeLineVat(2.3, 25)).toBe(0.58)
    expect(
      computeDeduction({ unit_price: 2.3, quantity: 1, deduction_type: 'rut', vat_rate: 25 }),
    ).toBe(1.44)
  })
})

describe('buildInvoiceWriteData with per-line discount and invoice_marking', () => {
  const baseHeader = {
    customer_id: 'customer-1',
    invoice_date: '2026-06-15',
    due_date: '2026-07-15',
    currency: 'SEK' as const,
  }

  it('stores net line totals, VAT on the net, and the discount on the row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: {
        ...baseHeader,
        items: [
          { description: 'Konsult', quantity: 10, unit: 'tim', unit_price: 1000, vat_rate: 25, discount_percent: 10 },
          { description: 'Resa', quantity: 1, unit: 'st', unit_price: 500, vat_rate: 25 },
        ],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 10 000 - 10% = 9 000 net + 500 undiscounted.
    expect(result.invoiceFields.subtotal).toBe(9500)
    expect(result.invoiceFields.vat_amount).toBe(2375)
    expect(result.invoiceFields.total).toBe(11875)
    expect(result.items[0]).toMatchObject({
      discount_percent: 10,
      line_total: 9000,
      vat_amount: 2250,
      unit_price: 1000,
    })
    expect(result.items[1]).toMatchObject({ discount_percent: 0, line_total: 500 })
  })

  it('maps invoice_marking to a concrete trimmed value, null when absent or blank', async () => {
    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const items = [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 100, vat_rate: 25 }]

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })
    const withMarking = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, invoice_marking: '  KST 4711  ', items },
    })
    expect(withMarking.ok).toBe(true)
    if (!withMarking.ok) return
    expect(withMarking.invoiceFields.invoice_marking).toBe('KST 4711')

    // Absent/blank input must produce an explicit null (supabase-js drops
    // undefined keys, and a draft edit that cleared the field relies on NULL
    // actually being written).
    const { supabase: supabase2, enqueue: enqueue2 } = createQueuedMockSupabase()
    enqueue2({ data: { vat_registered: true }, error: null })
    const withoutMarking = await buildInvoiceWriteData({
      supabase: supabase2 as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, invoice_marking: '   ', items },
    })
    expect(withoutMarking.ok).toBe(true)
    if (!withoutMarking.ok) return
    expect(withoutMarking.invoiceFields.invoice_marking).toBeNull()
  })

  it('computes the ROT deduction on the discounted line total', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'individual' })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: {
        ...baseHeader,
        deduction_personnummer: '199001019802',
        deduction_housing_designation: 'Testbrand 1:1',
        items: [
          {
            description: 'Renovering arbete',
            quantity: 10,
            unit: 'tim',
            unit_price: 1000,
            vat_rate: 25,
            discount_percent: 10,
            deduction_type: 'rot',
            work_type: 'BYGG',
            labor_hours: 10,
          },
        ],
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Net 9 000 excl VAT -> 11 250 incl VAT -> ROT 30% = 3 375.
    expect(result.items[0].deduction_amount).toBe(3375)
    expect(result.invoiceFields.deduction_total).toBe(3375)
  })
})
