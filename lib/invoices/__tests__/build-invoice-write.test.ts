import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import type { Customer, InvoiceDocumentType } from '@/types'

// Uses the REAL getVatRules / rot-rut-rules / personnummer helpers (only the
// supabase lookups are mocked) so the test exercises the same computation the
// POST and PATCH routes rely on.
function call(
  enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue'],
  supabase: SupabaseClient,
  customer: Customer,
  input: InvoiceWriteInput,
  documentType: InvoiceDocumentType = 'invoice',
) {
  return buildInvoiceWriteData({ supabase, companyId: 'company-1', customer, documentType, input })
}

const baseHeader = {
  customer_id: 'customer-1',
  invoice_date: '2026-06-15',
  due_date: '2026-07-15',
  currency: 'SEK' as const,
}

describe('buildInvoiceWriteData', () => {
  it('computes totals + item rows for a domestic 25% invoice and omits number/status', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null }) // company_settings.vat_registered

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 10, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.subtotal).toBe(10000)
    expect(result.invoiceFields.vat_amount).toBe(2500)
    expect(result.invoiceFields.total).toBe(12500)
    expect(result.invoiceFields.remaining_amount).toBe(12500)
    expect(result.invoiceFields.vat_rate).toBe(25)
    // The route owns these: the builder must never set them.
    expect(result.invoiceFields).not.toHaveProperty('invoice_number')
    expect(result.invoiceFields).not.toHaveProperty('status')
    expect(result.invoiceFields).not.toHaveProperty('user_id')
    // Item row carries no invoice_id: the route adds it.
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).not.toHaveProperty('invoice_id')
    expect(result.items[0]).toMatchObject({
      sort_order: 0,
      line_type: 'product',
      line_total: 10000,
      vat_rate: 25,
      vat_amount: 2500,
    })
  })

  it('maps payment_link_url to a concrete trimmed value, null when absent', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const withLink = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      payment_link_url: '  https://buy.stripe.com/test_abc123  ',
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })
    expect(withLink.ok).toBe(true)
    if (!withLink.ok) return
    expect(withLink.invoiceFields.payment_link_url).toBe('https://buy.stripe.com/test_abc123')

    // Absent input must still produce an explicit null (not undefined):
    // supabase-js drops undefined keys, and a draft edit that cleared the
    // field relies on the NULL actually being written.
    const { supabase: supabase2, enqueue: enqueue2 } = createQueuedMockSupabase()
    enqueue2({ data: { vat_registered: true }, error: null })
    const withoutLink = await call(enqueue2, supabase2 as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })
    expect(withoutLink.ok).toBe(true)
    if (!withoutLink.ok) return
    expect(withoutLink.invoiceFields.payment_link_url).toBeNull()
  })

  it('handles a mixed-rate invoice (vat_rate becomes null on the header)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        { description: 'Tjänst', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 },
        { description: 'Bok', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 6 },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_rate).toBeNull()
    expect(result.invoiceFields.vat_amount).toBe(250 + 60)
  })

  it('zeroes VAT when the company is not VAT-registered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: false }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(0)
    expect(result.invoiceFields.total).toBe(1000)
    expect(result.invoiceFields.vat_treatment).toBe('exempt')
    expect(result.items[0].vat_rate).toBe(0)
  })

  it('rejects a VAT rate not allowed for the customer type', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // EU business with a validated VAT number → reverse charge, only 0% allowed.
    const customer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('code' in result && result.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
  })

  it('excludes free-text rows from totals', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        { description: 'Rubrik', quantity: 0, unit: '', unit_price: 0, vat_rate: 0, line_type: 'text' },
        { description: 'Konsult', quantity: 2, unit: 'tim', unit_price: 500, vat_rate: 25 },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.subtotal).toBe(1000)
    expect(result.invoiceFields.vat_amount).toBe(250)
    expect(result.items[0]).toMatchObject({ line_type: 'text', line_total: 0, vat_amount: 0 })
  })
})
