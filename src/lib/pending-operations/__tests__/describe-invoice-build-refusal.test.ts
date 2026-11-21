import { describe, it, expect } from 'vitest'
import { describeInvoiceBuildRefusal } from '@/lib/pending-operations/build-staged-invoice'
import { DEDUCTION_INVOICE_ONLY_ERROR } from '@/lib/bookkeeping/rot-rut-rules'

/**
 * What an MCP agent reads when gnubok_create_invoice is refused for a
 * skattereduktion: the builder's errors and one hint that fits the reason.
 */
describe('describeInvoiceBuildRefusal: ROT/RUT', () => {
  it('points a claim on a quote at the invoice it belongs on, not at the personnummer', () => {
    const text = describeInvoiceBuildRefusal('INVOICE_CREATE_ROT_RUT_VALIDATION', {
      reason: 'document_type',
      documentType: 'quote',
      errors: [DEDUCTION_INVOICE_ONLY_ERROR],
      warnings: [],
    })
    expect(text).toContain(DEDUCTION_INVOICE_ONLY_ERROR)
    expect(text).toContain('gnubok_convert_invoice')
    expect(text).not.toMatch(/customer card/)
  })

  it('keeps the personnummer hint for a claim refused on an invoice', () => {
    const text = describeInvoiceBuildRefusal('INVOICE_CREATE_ROT_RUT_VALIDATION', {
      errors: ['Personnummer krävs för ROT-avdrag.'],
      warnings: [],
    })
    expect(text).toMatch(/customer card/)
  })
})
