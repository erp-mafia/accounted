import { describe, it, expect } from 'vitest'
import { hasRequiredSellerVatNumber } from '../seller-vat-number'

const realInvoice = { credited_invoice_id: null, document_type: 'invoice' as const }

describe('hasRequiredSellerVatNumber', () => {
  it('requires a VAT number for a registered company issuing a real invoice', () => {
    expect(
      hasRequiredSellerVatNumber({ vat_registered: true, vat_number: null }, realInvoice),
    ).toBe(false)
    expect(
      hasRequiredSellerVatNumber({ vat_registered: true, vat_number: '   ' }, realInvoice),
    ).toBe(false)
    expect(
      hasRequiredSellerVatNumber(
        { vat_registered: true, vat_number: 'SE556012579001' },
        realInvoice,
      ),
    ).toBe(true)
  })

  it('does not require a VAT number for an unregistered company', () => {
    expect(
      hasRequiredSellerVatNumber({ vat_registered: false, vat_number: null }, realInvoice),
    ).toBe(true)
  })

  it('exempts credit notes, proformas, quotes, and delivery notes', () => {
    const broken = { vat_registered: true, vat_number: null }
    expect(
      hasRequiredSellerVatNumber(broken, { credited_invoice_id: 'inv-0', document_type: 'invoice' }),
    ).toBe(true)
    expect(
      hasRequiredSellerVatNumber(broken, { credited_invoice_id: null, document_type: 'proforma' }),
    ).toBe(true)
    expect(
      hasRequiredSellerVatNumber(broken, { credited_invoice_id: null, document_type: 'quote' }),
    ).toBe(true)
    expect(
      hasRequiredSellerVatNumber(broken, { credited_invoice_id: null, document_type: 'delivery_note' }),
    ).toBe(true)
  })
})
