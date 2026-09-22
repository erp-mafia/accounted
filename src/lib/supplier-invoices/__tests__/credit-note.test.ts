import { describe, expect, it } from 'vitest'
import { makeSupplierInvoice } from '@/tests/helpers'
import { SUPPLIER_CREDIT_NOTE_STATUS, buildSupplierCreditNoteRow } from '../credit-note'

const CTX = { userId: 'user-1', companyId: 'company-1', arrivalNumber: 7, date: '2026-09-04' }

describe('buildSupplierCreditNoteRow', () => {
  it('rests the credit note at credited, never at the attest entry state', () => {
    const row = buildSupplierCreditNoteRow(makeSupplierInvoice({ id: 'si-1' }), CTX)
    expect(SUPPLIER_CREDIT_NOTE_STATUS).toBe('credited')
    expect(row.status).toBe('credited')
    expect(row.is_credit_note).toBe(true)
    expect(row.credited_invoice_id).toBe('si-1')
    expect(row.remaining_amount).toBe(0)
  })

  it('mirrors the original amounts and identity under the KREDIT- prefix', () => {
    const original = makeSupplierInvoice({
      id: 'si-1',
      supplier_id: 'sup-1',
      supplier_invoice_number: '528285626420',
      currency: 'EUR',
      exchange_rate: 11.2,
      vat_treatment: 'standard_25',
      reverse_charge: false,
      subtotal: 1048,
      subtotal_sek: 11737.6,
      vat_amount: 262,
      vat_amount_sek: 2934.4,
      total: 1310,
      total_sek: 14672,
    })
    const row = buildSupplierCreditNoteRow(
      { ...original, default_dimensions: { cost_center: 'cc-1' } },
      CTX,
    )
    expect(row).toMatchObject({
      user_id: 'user-1',
      company_id: 'company-1',
      supplier_id: 'sup-1',
      arrival_number: 7,
      supplier_invoice_number: 'KREDIT-528285626420',
      invoice_date: '2026-09-04',
      due_date: '2026-09-04',
      currency: 'EUR',
      exchange_rate: 11.2,
      subtotal: 1048,
      subtotal_sek: 11737.6,
      vat_amount: 262,
      vat_amount_sek: 2934.4,
      total: 1310,
      total_sek: 14672,
      default_dimensions: { cost_center: 'cc-1' },
    })
  })

  it('defaults a missing dimension bag to an empty object', () => {
    const row = buildSupplierCreditNoteRow(makeSupplierInvoice({ id: 'si-1' }), CTX)
    expect(row.default_dimensions).toEqual({})
  })
})
