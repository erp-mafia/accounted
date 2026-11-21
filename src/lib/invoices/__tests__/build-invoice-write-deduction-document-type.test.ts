import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { DEDUCTION_INVOICE_ONLY_ERROR } from '@/lib/bookkeeping/rot-rut-rules'
import type { InvoiceDocumentType } from '@/types'

/**
 * A skattereduktion (ROT, RUT, grön teknik) exists on a faktura only: a
 * quote, a proforma and a delivery note store none. A line that claims one
 * on those documents is refused with the code every ROT/RUT refusal carries,
 * as a periodisering on them is (INVOICE_CREATE_ACCRUAL_INVALID), instead of
 * being validated and then stored without the claim.
 */

const header = {
  customer_id: 'customer-1',
  invoice_date: '2026-09-15',
  due_date: '2026-10-15',
  valid_until: '2026-10-15',
  currency: 'SEK' as const,
  deduction_personnummer: '199110306645',
}

const rutLabour = {
  description: 'Trädgårdsarbete',
  quantity: 16,
  unit: 'tim',
  unit_price: 500,
  vat_rate: 25,
  deduction_type: 'rut' as const,
  work_type: 'TRADGARD',
  labor_hours: 16,
}

async function build(documentType: InvoiceDocumentType, items: InvoiceWriteInput['items']) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { vat_registered: true }, error: null })
  return buildInvoiceWriteData({
    supabase: supabase as unknown as SupabaseClient,
    companyId: 'company-1',
    customer: makeCustomer({ customer_type: 'individual' }),
    documentType,
    input: { ...header, items } as InvoiceWriteInput,
  })
}

describe('buildInvoiceWriteData: a deduction line on a document that is not a faktura', () => {
  it('names the documents that cannot carry a claim', () => {
    expect(DEDUCTION_INVOICE_ONLY_ERROR).toMatch(/offert, proforma eller följesedel/)
  })

  it.each(['quote', 'proforma', 'delivery_note'] as const)(
    'refuses a RUT line on a %s instead of storing it without the claim',
    async (documentType) => {
      const result = await build(documentType, [rutLabour])
      expect(result).toEqual({
        ok: false,
        code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
        details: { reason: 'document_type', documentType, errors: [DEDUCTION_INVOICE_ONLY_ERROR], warnings: [] },
      })
    },
  )

  it('refuses an incomplete claim on a quote too: no field of it would be kept', async () => {
    const result = await build('quote', [{ ...rutLabour, work_type: null, labor_hours: null }])
    expect(result.ok).toBe(false)
    if (result.ok || !('code' in result)) return
    expect(result.code).toBe('INVOICE_CREATE_ROT_RUT_VALIDATION')
  })

  it('saves a quote whose lines claim nothing, as it does today', async () => {
    const result = await build('quote', [{ ...rutLabour, deduction_type: null, work_type: null, labor_hours: null }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_total).toBe(0)
    expect(result.items[0]).toMatchObject({ deduction_type: null, deduction_amount: 0 })
  })

  it('ignores a deduction flag on a text row, as an invoice does', async () => {
    const result = await build('quote', [
      { line_type: 'text', description: 'Enligt överenskommelse', quantity: 0, unit: '', unit_price: 0, deduction_type: 'rut' },
      { ...rutLabour, deduction_type: null, work_type: null, labor_hours: null },
    ] as InvoiceWriteInput['items'])
    expect(result.ok).toBe(true)
  })

  it('still books the claim on a faktura', async () => {
    const result = await build('invoice', [rutLabour])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_total).toBeGreaterThan(0)
    expect(result.items[0]).toMatchObject({ deduction_type: 'rut', work_type: 'TRADGARD', labor_hours: 16 })
  })
})
