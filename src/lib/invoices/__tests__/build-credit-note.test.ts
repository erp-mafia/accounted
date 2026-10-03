import { describe, expect, it } from 'vitest'
import {
  buildCreditNoteFields,
  creditNoteNumber,
  creditNoteOriginalReference,
} from '@/lib/invoices/build-credit-note'
import { makeInvoice } from '@/tests/helpers'

describe('creditNoteOriginalReference', () => {
  it('is the invoice number, or the external number of a self-billed original (#1820)', () => {
    expect(creditNoteOriginalReference({ invoice_number: '1043', external_invoice_number: null })).toBe('1043')
    expect(creditNoteOriginalReference({ invoice_number: null, external_invoice_number: 'SB-7' })).toBe('SB-7')
    expect(creditNoteOriginalReference({ invoice_number: null, external_invoice_number: null })).toBeNull()
  })
})

describe('creditNoteNumber', () => {
  it('is deterministic, so a retry reuses it', () => {
    expect(creditNoteNumber('1043')).toBe('KR-1043')
  })
})

describe('buildCreditNoteFields', () => {
  const original = makeInvoice({
    id: 'orig-1',
    customer_id: 'cust-1',
    invoice_number: '1043',
    currency: 'EUR',
    exchange_rate: 11.02,
    exchange_rate_date: '2026-09-30',
    subtotal: 4200,
    subtotal_sek: 46284,
    vat_amount: 0,
    vat_amount_sek: 0,
    total: 4200,
    total_sek: 46284,
    vat_treatment: 'reverse_charge',
    moms_ruta: '39',
    reverse_charge_text: 'Omvänd skattskyldighet',
    deduction_total: 0,
    your_reference: 'Mette',
    our_reference: 'Anna',
    payment_details: { iban: 'SE4550000000058398257466' } as never,
    default_dimensions: { '6': 'P001' },
  })

  it('negates the amounts and keeps the VAT, references, payee and rate of the original', () => {
    const fields = buildCreditNoteFields(original, { originalReference: '1043', today: '2026-10-05' })

    expect(fields).toMatchObject({
      customer_id: 'cust-1',
      credited_invoice_id: 'orig-1',
      invoice_date: '2026-10-05',
      due_date: '2026-10-05',
      currency: 'EUR',
      exchange_rate: 11.02,
      subtotal: -4200,
      subtotal_sek: -46284,
      total: -4200,
      total_sek: -46284,
      vat_treatment: 'reverse_charge',
      moms_ruta: '39',
      reverse_charge_text: 'Omvänd skattskyldighet',
      your_reference: 'Mette',
      our_reference: 'Anna',
      payment_details: { iban: 'SE4550000000058398257466' },
      default_dimensions: { '6': 'P001' },
    })
  })

  it('keeps the deduction a positive magnitude (CHECK deduction_total >= 0)', () => {
    const rot = { ...original, currency: 'SEK' as const, deduction_total: 6750 }
    expect(buildCreditNoteFields(rot, { originalReference: '1043', today: '2026-10-05' }).deduction_total).toBe(6750)
  })

  it('prints the reason as the note, else the reference to the original', () => {
    expect(buildCreditNoteFields(original, { originalReference: '1043', reason: 'Fel antal timmar.', today: '2026-10-05' }).notes)
      .toBe('Fel antal timmar.')
    expect(buildCreditNoteFields(original, { originalReference: '1043', reason: null, today: '2026-10-05' }).notes)
      .toBe('Krediterar faktura 1043')
  })
})
