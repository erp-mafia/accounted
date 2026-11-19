import { describe, expect, it } from 'vitest'
import { invoiceFinePrint } from '@/lib/invoices/fine-print'

const SWEDISH = { invoice_late_fee_text: 'Dröjsmålsränta enligt räntelagen.', invoice_credit_terms_text: 'Betalning inom 30 dagar.' }

describe('invoiceFinePrint (crm#1735)', () => {
  it('gives a Swedish invoice the Swedish texts, as stored', () => {
    expect(
      invoiceFinePrint({ ...SWEDISH, invoice_late_fee_text_en: 'Interest.', invoice_credit_terms_text_en: 'Pay in 30 days.' }, 'sv'),
    ).toEqual({ lateFee: 'Dröjsmålsränta enligt räntelagen.', creditTerms: 'Betalning inom 30 dagar.' })
  })

  it('gives an English invoice the English texts where set, the Swedish ones where not', () => {
    expect(
      invoiceFinePrint({ ...SWEDISH, invoice_late_fee_text_en: 'Interest.', invoice_credit_terms_text_en: 'Pay in 30 days.' }, 'en'),
    ).toEqual({ lateFee: 'Interest.', creditTerms: 'Pay in 30 days.' })
    expect(invoiceFinePrint({ ...SWEDISH, invoice_credit_terms_text_en: '   ' }, 'en')).toEqual({
      lateFee: 'Dröjsmålsränta enligt räntelagen.',
      creditTerms: 'Betalning inom 30 dagar.',
    })
  })

  it('treats blank, null and non-string values as unset', () => {
    expect(
      invoiceFinePrint(
        { invoice_late_fee_text: ' ', invoice_credit_terms_text: null, invoice_late_fee_text_en: 7 as unknown as string },
        'en',
      ),
    ).toEqual({ lateFee: null, creditTerms: null })
    expect(invoiceFinePrint(null, 'en')).toEqual({ lateFee: null, creditTerms: null })
  })
})
