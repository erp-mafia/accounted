import { describe, expect, it } from 'vitest'
import { makeInvoice } from '@/tests/helpers'
import { buildInvoiceCopyInitial } from '@/lib/invoices/copy-invoice'
import { buildInvoiceWritePayload, sanitizeDeductionItems } from '@/lib/invoices/editor-payload'
import type { InvoiceItem } from '@/types'

/**
 * A copied grön teknik invoice keeps what defines each claim line (kind,
 * installation type, hours) and drops what belongs to the old recipient (the
 * property), like ROT/RUT; the editor payload sends grön teknik line fields
 * only on flagged lines.
 */

const gronLine: InvoiceItem = {
  id: 'item-1',
  invoice_id: 'invoice-1',
  sort_order: 0,
  line_type: 'product',
  description: 'Montage solceller',
  quantity: 1,
  unit: 'st',
  unit_price: 20000,
  line_total: 20000,
  vat_rate: 25,
  vat_amount: 5000,
  deduction_type: 'gron_teknik',
  deduction_amount: 3750,
  labor_hours: 24,
  work_type: 'INSTALLATION_SOLCELLER',
  housing_designation: 'Exempelby 1:1',
  apartment_number: '1201',
  brf_org_number: '799900-0040',
  created_at: '2026-09-01T00:00:00Z',
}

describe('grön teknik on copy and in the editor payload', () => {
  it('copy keeps the kind, installation type and hours, and clears the property', () => {
    const copy = buildInvoiceCopyInitial(makeInvoice({ status: 'paid', items: [gronLine] }) as never)
    expect(copy.items[0]).toMatchObject({
      deduction_type: 'gron_teknik',
      work_type: 'INSTALLATION_SOLCELLER',
      labor_hours: 24,
      housing_designation: null,
      apartment_number: null,
      brf_org_number: null,
    })
  })

  it('the payload keeps grön teknik fields on flagged lines and strips them elsewhere', () => {
    const plain = { ...gronLine, deduction_type: null }
    const [flagged, stripped] = sanitizeDeductionItems([gronLine, plain])
    expect(flagged).toMatchObject({ deduction_type: 'gron_teknik', work_type: 'INSTALLATION_SOLCELLER' })
    expect(stripped).not.toHaveProperty('work_type')
    expect(stripped).not.toHaveProperty('housing_designation')

    const body = buildInvoiceWritePayload(
      { items: [gronLine], deduction_personnummer: '199110306645', deduction_housing_designation: 'Exempelby 1:1' },
      { oreRounding: true, defaultDims: {} },
    )
    expect(body).toMatchObject({ deduction_personnummer: '199110306645', deduction_housing_designation: 'Exempelby 1:1' })
  })
})
