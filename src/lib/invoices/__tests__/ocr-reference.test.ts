import { describe, expect, it } from 'vitest'
import {
  invoiceOcrReference,
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

  it("carries Bankgirot's length digit before the check digit when the company prints one", () => {
    const withLength = { ...giro, invoice_ocr_length_digit: true }
    // 1042: six digits in all, so length digit 6, then the check digit over 10426.
    expect(invoicePaymentReference(withLength, '1042', 'sv')).toEqual({ type: 'ocr', reference: '104265' })
    expect(invoicePaymentReference(withLength, 'F-2026-0042', 'sv')).toEqual({ type: 'ocr', reference: '2026004206' })
    // Off, null and never written all print the plain form.
    expect(invoicePaymentReference({ ...giro, invoice_ocr_length_digit: false }, '1042', 'sv').reference).toBe('10421')
    expect(invoicePaymentReference({ ...giro, invoice_ocr_length_digit: null }, '1042', 'sv').reference).toBe('10421')
  })

  it('leaves the invoice number alone when no OCR is shown, whatever the OCR form', () => {
    const withLength = { ...giro, invoice_ocr_length_digit: true }
    expect(invoicePaymentReference(withLength, '1042', 'en')).toEqual({ type: 'invoice_number', reference: '1042' })
    expect(invoicePaymentReference({ ...withLength, invoice_show_ocr: false }, '1042', 'sv')).toEqual({
      type: 'invoice_number',
      reference: '1042',
    })
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

describe('invoiceOcrReference', () => {
  it('is the number and its check digit, with the length digit between them when switched on', () => {
    expect(invoiceOcrReference({}, '1042')).toBe('10421')
    expect(invoiceOcrReference({ invoice_ocr_length_digit: false }, '1042')).toBe('10421')
    expect(invoiceOcrReference({ invoice_ocr_length_digit: true }, '1042')).toBe('104265')
    // The length digit is the whole reference's length modulo 10: ten digits give 0.
    expect(invoiceOcrReference({ invoice_ocr_length_digit: true }, '20260042')).toBe('2026004206')
  })

  it('keeps the plain form for a number the length-digit form cannot carry', () => {
    // 24 digits: the plain reference is 25 digits, and a length digit would make 26.
    const number = '123456789012345678901234'
    expect(invoiceOcrReference({ invoice_ocr_length_digit: true }, number)).toBe(invoiceOcrReference({}, number))
    expect(invoiceOcrReference({ invoice_ocr_length_digit: true }, number)).toHaveLength(25)
  })
})
