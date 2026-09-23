import { describe, expect, it } from 'vitest'
import { invoiceShowsOcrReference } from '@/lib/invoices/ocr-reference'

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
})
