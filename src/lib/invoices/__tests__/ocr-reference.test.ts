import { describe, expect, it } from 'vitest'
import {
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
