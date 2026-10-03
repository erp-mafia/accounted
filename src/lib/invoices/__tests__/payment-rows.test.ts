/**
 * The payment rows the PDF and the invoice email share
 * (lib/invoices/payment-rows.ts): what prints, in which order, under the
 * row budget, and exactly one reference row.
 */
import { describe, expect, it } from 'vitest'
import {
  INVOICE_PAYMENT_ROW_LIMIT,
  buildInvoicePaymentRows,
  type InvoicePaymentRowsCompany,
  type InvoicePaymentRowsInvoice,
} from '@/lib/invoices/payment-rows'

const NONE: InvoicePaymentRowsCompany = {
  bank_name: null,
  clearing_number: null,
  account_number: null,
  bankgiro: null,
  plusgiro: null,
  swish: null,
  iban: null,
  bic: null,
  bank_code: null,
  foreign_account_number: null,
  invoice_show_bankgiro: true,
  invoice_show_plusgiro: true,
  invoice_show_swish: true,
  invoice_show_ocr: true,
}

function rows(
  company: Partial<InvoicePaymentRowsCompany>,
  invoice: Partial<InvoicePaymentRowsInvoice> = {},
  lang: 'sv' | 'en' = 'sv',
) {
  return buildInvoicePaymentRows({
    company: { ...NONE, ...company },
    invoice: { invoice_number: '1042', currency: 'SEK', payment_link_url: null, ...invoice },
    lang,
  })
}

const keys = (list: ReturnType<typeof rows>) => list.map((row) => row.key)

describe('buildInvoicePaymentRows: order and content', () => {
  it('lists the methods in the fixed priority order, then the reference', () => {
    const list = rows(
      {
        bankgiro: '5050-1055',
        plusgiro: '123456-6',
        bank_name: 'SEB',
        clearing_number: '5000',
        account_number: '1234567',
        swish: '1234567890',
        iban: 'SE4550000000058398257466',
      },
      { payment_link_url: 'https://pay.example.test/x' },
    )
    expect(keys(list)).toEqual(['bankgiro', 'plusgiro', 'bank_account', 'swish', 'iban', 'payment_link', 'ocr'])
  })

  it('merges bank, clearing and account number into one Bankkonto row', () => {
    const list = rows({ bank_name: 'Handelsbanken', clearing_number: '6123', account_number: '456789012' })
    expect(list[0]).toEqual({ key: 'bank_account', label: 'Bankkonto:', value: 'Handelsbanken, 6123-456789012' })
  })

  it('prints the account only when both clearing and account number are set (no half account)', () => {
    expect(keys(rows({ bank_name: 'SEB', clearing_number: '5000' }))).toEqual(['message'])
    expect(keys(rows({ account_number: '1234567' }))).toEqual(['message'])
    expect(rows({ clearing_number: '5000', account_number: '1234567' })[0].value).toBe('5000-1234567')
  })

  it('prints a foreign account number in the account row, with the routing label of the currency', () => {
    const usd = rows(
      { bank_name: 'Chase', foreign_account_number: '000123456789', bic: 'CHASUS33', bank_code: '021000021' },
      { currency: 'USD' },
      'en',
    )
    expect(usd.map((row) => `${row.label} ${row.value}`)).toEqual([
      'Bank account: Chase, 000123456789',
      'BIC/SWIFT: CHASUS33',
      'Routing number (ABA): 021000021',
      'Reference: 1042',
    ])
    expect(rows({ bank_code: '401276' }, { currency: 'GBP' })[0]).toMatchObject({ key: 'sort_code', label: 'Sort code:' })
    expect(rows({ bank_code: '12345' }, { currency: 'EUR' })[0]).toMatchObject({ key: 'bank_code', label: 'Bankkod:' })
  })

  it('leaves out a giro or Swish number the company hides', () => {
    const list = rows({
      bankgiro: '5050-1055',
      plusgiro: '123456-6',
      swish: '1234567890',
      invoice_show_bankgiro: false,
      invoice_show_swish: false,
    })
    expect(keys(list)).toEqual(['plusgiro', 'ocr'])
  })

  it('keeps Swish off unless the company shows it (the setting defaults off)', () => {
    expect(keys(rows({ swish: '1234567890', invoice_show_swish: null }))).toEqual(['message'])
  })
})

describe('buildInvoicePaymentRows: exactly one reference row', () => {
  it('is the OCR reference when a giro prints on a Swedish invoice', () => {
    const list = rows({ bankgiro: '5050-1055' })
    expect(list.at(-1)).toEqual({ key: 'ocr', label: 'OCR/Referens:', value: '10421', emphasis: true })
  })

  it('is Meddelande with the invoice number when no giro prints', () => {
    expect(rows({ iban: 'SE4550000000058398257466' }).at(-1)).toEqual({
      key: 'message',
      label: 'Meddelande:',
      value: '1042',
      emphasis: true,
    })
    // A stored but hidden bankgiro does not count: no OCR without a giro to pay it to.
    expect(rows({ bankgiro: '5050-1055', invoice_show_bankgiro: false }).at(-1)?.key).toBe('message')
  })

  it('is Meddelande when the company switched the OCR row off', () => {
    expect(rows({ bankgiro: '5050-1055', invoice_show_ocr: false }).at(-1)?.key).toBe('message')
  })

  it('is "Reference: <invoice number>" on an English invoice, never an OCR', () => {
    expect(rows({ bankgiro: '5050-1055' }, {}, 'en').at(-1)).toEqual({
      key: 'message',
      label: 'Reference:',
      value: '1042',
      emphasis: true,
    })
  })

  it('shows a dash on an unnumbered draft', () => {
    expect(rows({ bankgiro: '5050-1055' }, { invoice_number: null }).at(-1)?.value).toBe('-')
    expect(rows({}, { invoice_number: null }).at(-1)?.value).toBe('-')
  })

  it('appears once, whatever prints', () => {
    const list = rows({ bankgiro: '5050-1055', plusgiro: '123456-6' })
    expect(list.filter((row) => row.emphasis)).toHaveLength(1)
  })
})

describe('buildInvoicePaymentRows: row budget', () => {
  it(`prints at most ${INVOICE_PAYMENT_ROW_LIMIT} rows, dropping the lowest-priority methods and keeping the reference`, () => {
    const list = rows(
      {
        bankgiro: '5050-1055',
        plusgiro: '123456-6',
        bank_name: 'SEB',
        clearing_number: '5000',
        account_number: '1234567',
        swish: '1234567890',
        iban: 'SE4550000000058398257466',
        bic: 'ESSESESS',
        bank_code: '12345',
      },
      { payment_link_url: 'https://pay.example.test/x' },
    )
    expect(list).toHaveLength(INVOICE_PAYMENT_ROW_LIMIT)
    expect(keys(list)).toEqual(['bankgiro', 'plusgiro', 'bank_account', 'swish', 'iban', 'bic', 'ocr'])
  })
})

describe('payment row display formatting', () => {
  it('groups a business Swish number and an IBAN the way banks print them', async () => {
    const { formatSwishForDisplay, formatIbanForDisplay } = await import('@/lib/invoices/payment-rows')
    expect(formatSwishForDisplay('1231181189')).toBe('123 118 11 89')
    expect(formatSwishForDisplay('0701234567')).toBe('070-123 45 67')
    expect(formatSwishForDisplay('12345')).toBe('12345')
    expect(formatSwishForDisplay(null)).toBe(null)
    expect(formatIbanForDisplay('SE4550000000058398257466')).toBe('SE45 5000 0000 0583 9825 7466')
    expect(formatIbanForDisplay('se45 5000 0000 0583 9825 7466')).toBe('SE45 5000 0000 0583 9825 7466')
  })
})
