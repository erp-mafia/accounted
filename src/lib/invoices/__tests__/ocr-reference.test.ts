import { describe, expect, it } from 'vitest'
import {
  invoicePaymentReference,
  invoicePrintsBankgiro,
  invoicePrintsPlusgiro,
  invoiceShowsOcrReference,
} from '@/lib/invoices/ocr-reference'

describe('invoiceShowsOcrReference', () => {
  it('shows the OCR only for Swedish invoices paid to a bankgiro or plusgiro', () => {
    expect(invoiceShowsOcrReference({ invoice_show_ocr: true, bankgiro: '123-4567', plusgiro: null }, 'sv')).toBe(true)
    expect(invoiceShowsOcrReference({ invoice_show_ocr: true, bankgiro: null, plusgiro: '12 34 56-7' }, 'sv')).toBe(true)
    expect(invoiceShowsOcrReference({ invoice_show_ocr: true, bankgiro: null, plusgiro: null }, 'sv')).toBe(false)
    expect(invoiceShowsOcrReference({ invoice_show_ocr: true, bankgiro: '123-4567', plusgiro: null }, 'en')).toBe(false)
  })

  it('defaults to on when the setting was never written, and honours an explicit off', () => {
    expect(invoiceShowsOcrReference({ invoice_show_ocr: undefined, bankgiro: '123-4567', plusgiro: null }, 'sv')).toBe(true)
    expect(invoiceShowsOcrReference({ invoice_show_ocr: false, bankgiro: '123-4567', plusgiro: null }, 'sv')).toBe(false)
  })

  it('needs a giro the invoice PRINTS: a stored but hidden giro gives the customer nothing to pay the OCR to', () => {
    expect(
      invoiceShowsOcrReference({ bankgiro: '123-4567', plusgiro: null, invoice_show_bankgiro: false }, 'sv'),
    ).toBe(false)
    expect(
      invoiceShowsOcrReference({ bankgiro: null, plusgiro: '12 34 56-7', invoice_show_plusgiro: false }, 'sv'),
    ).toBe(false)
    expect(
      invoiceShowsOcrReference(
        { bankgiro: '123-4567', plusgiro: '12 34 56-7', invoice_show_bankgiro: false, invoice_show_plusgiro: false },
        'sv',
      ),
    ).toBe(false)
  })

  it('keeps the OCR when one giro is hidden and the other prints', () => {
    expect(
      invoiceShowsOcrReference({ bankgiro: '123-4567', plusgiro: '12 34 56-7', invoice_show_bankgiro: false }, 'sv'),
    ).toBe(true)
    expect(
      invoiceShowsOcrReference({ bankgiro: '123-4567', plusgiro: '12 34 56-7', invoice_show_plusgiro: false }, 'sv'),
    ).toBe(true)
  })

  it('does not count a blank giro as printed', () => {
    expect(invoiceShowsOcrReference({ bankgiro: '   ', plusgiro: null }, 'sv')).toBe(false)
  })
})

describe('invoicePrintsBankgiro / invoicePrintsPlusgiro', () => {
  it('prints a set giro unless the company hid it; unset flags default to shown', () => {
    expect(invoicePrintsBankgiro({ bankgiro: '123-4567' })).toBe(true)
    expect(invoicePrintsBankgiro({ bankgiro: '123-4567', invoice_show_bankgiro: null })).toBe(true)
    expect(invoicePrintsBankgiro({ bankgiro: '123-4567', invoice_show_bankgiro: false })).toBe(false)
    expect(invoicePrintsBankgiro({ bankgiro: null })).toBe(false)
    expect(invoicePrintsPlusgiro({ plusgiro: '12 34 56-7' })).toBe(true)
    expect(invoicePrintsPlusgiro({ plusgiro: '12 34 56-7', invoice_show_plusgiro: false })).toBe(false)
    expect(invoicePrintsPlusgiro({ plusgiro: '' })).toBe(false)
  })
})

// crm#1886: the one choice between the OCR reference and the invoice number,
// read by the PDF, the mails, the QR, the mailbox and the API field.
describe('invoicePaymentReference', () => {
  const giro = { bankgiro: '5050-1055', plusgiro: null }

  it('is the digits of the number plus a Luhn check digit when the invoice shows an OCR', () => {
    expect(invoicePaymentReference(giro, '0073', 'sv')).toEqual({ type: 'ocr', reference: '00737' })
    // Letters and separators are not part of an OCR reference.
    expect(invoicePaymentReference(giro, 'F-2026-0042', 'sv')).toEqual({ type: 'ocr', reference: '202600425' })
    expect(invoicePaymentReference(giro, ' 1042 ', 'sv')).toEqual({ type: 'ocr', reference: '10421' })
  })

  it('is the invoice number as it is when no OCR is shown', () => {
    expect(invoicePaymentReference({}, 'F-2026-0042', 'sv')).toEqual({ type: 'invoice_number', reference: 'F-2026-0042' })
    expect(invoicePaymentReference(giro, 'F-2026-0042', 'en')).toEqual({ type: 'invoice_number', reference: 'F-2026-0042' })
    expect(invoicePaymentReference({ ...giro, invoice_show_ocr: false }, '1042', 'sv')).toEqual({
      type: 'invoice_number',
      reference: '1042',
    })
    expect(invoicePaymentReference({ ...giro, invoice_show_bankgiro: false }, '1042', 'sv')).toEqual({
      type: 'invoice_number',
      reference: '1042',
    })
  })

  it('says which kind the invoice will carry before it has a number, with no reference yet', () => {
    expect(invoicePaymentReference(giro, null, 'sv')).toEqual({ type: 'ocr', reference: null })
    expect(invoicePaymentReference(giro, '   ', 'sv')).toEqual({ type: 'ocr', reference: null })
    expect(invoicePaymentReference({}, undefined, 'sv')).toEqual({ type: 'invoice_number', reference: null })
  })
})
