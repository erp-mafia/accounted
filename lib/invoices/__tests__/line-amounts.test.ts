import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { computeLineAmounts, computeLineNet, hasLineDiscount } from '@/lib/invoices/line-amounts'
import { computeDeduction } from '@/lib/invoices/rot-rut-rules'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'

describe('computeLineAmounts', () => {
  it('passes qty * price through untouched when no discount applies', () => {
    // Legacy parity: existing invoices store the unrounded product.
    expect(computeLineAmounts(3, 33.333)).toEqual({
      gross: 3 * 33.333,
      discount: 0,
      net: 3 * 33.333,
    })
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
