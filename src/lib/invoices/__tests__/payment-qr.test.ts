/**
 * ONE payment QR code per invoice (lib/invoices/payment-qr.ts): which code
 * an invoice prints for each QR mode, the amount it encodes, and the stable
 * reason code when it prints none.
 */
import { describe, expect, it } from 'vitest'
import {
  INVOICE_QR_CAPTIONS,
  describeInvoicePaymentQr,
  resolveInvoicePaymentQr,
  resolveInvoiceQrMode,
  type ResolveInvoicePaymentQrInput,
  type ResolvedInvoicePaymentQr,
} from '@/lib/invoices/payment-qr'
import { buildBankPaymentQrPayload } from '@/lib/invoices/bank-payment-qr'
import { makeCompanySettings, makeInvoice } from '@/tests/helpers'
import type { CompanySettings, Invoice, InvoiceQrMode } from '@/types'

const LINK = 'https://buy.stripe.com/test_abc123'

/** A company that can print every code: bankgiro, org number, Swish shown. */
const company = (overrides: Partial<CompanySettings> = {}): CompanySettings =>
  makeCompanySettings({
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
    bankgiro: '5050-1055',
    plusgiro: null,
    swish: '1234567890',
    invoice_show_swish: true,
    invoice_qr_mode: 'auto',
    ...overrides,
  })

const invoice = (overrides: Partial<Invoice> = {}): Invoice =>
  makeInvoice({
    status: 'sent',
    invoice_number: '10234',
    invoice_date: '2026-10-01',
    due_date: '2026-10-31',
    total: 12500,
    remaining_amount: 12500,
    ...overrides,
  })

const business = { customer_type: 'swedish_business' }
const privatePerson = { customer_type: 'individual' }

function resolve(
  overrides: {
    invoice?: Partial<Invoice>
    company?: Partial<CompanySettings>
    customer?: ResolveInvoicePaymentQrInput['customer']
    lang?: 'sv' | 'en'
  } = {},
): ResolvedInvoicePaymentQr {
  return resolveInvoicePaymentQr({
    invoice: invoice(overrides.invoice),
    company: company(overrides.company),
    customer: overrides.customer === undefined ? business : overrides.customer,
    lang: overrides.lang ?? 'sv',
  })
}

/** The QR mode set on the invoice itself. */
const withMode = (qr_mode: InvoiceQrMode, rest: Partial<Invoice> = {}) => ({ ...rest, qr_mode })

describe('resolveInvoiceQrMode', () => {
  it('takes the invoice override, else the company default, else auto', () => {
    expect(resolveInvoiceQrMode({ qr_mode: 'swish' }, { invoice_qr_mode: 'bank_app' })).toBe('swish')
    expect(resolveInvoiceQrMode({ qr_mode: null }, { invoice_qr_mode: 'bank_app' })).toBe('bank_app')
    expect(resolveInvoiceQrMode({}, {})).toBe('auto')
  })

  it('ignores a value that is not a mode', () => {
    expect(resolveInvoiceQrMode({ qr_mode: 'qr' as InvoiceQrMode }, { invoice_qr_mode: 'none' })).toBe('none')
    expect(resolveInvoiceQrMode({}, { invoice_qr_mode: 'all' as InvoiceQrMode })).toBe('auto')
  })
})

describe('resolveInvoicePaymentQr: auto', () => {
  it('gives a private customer Swish when Swish is usable', () => {
    const qr = resolve({ customer: privatePerson })
    expect(qr).toMatchObject({ kind: 'swish', mode: 'auto', amount: 12500, payload: 'C1234567890;12500.00;10234;0' })
    expect(qr.kind && qr.caption).toBe('Skanna för att betala med Swish')
  })

  it('gives a business with a printed bankgiro and an org number the bank-app code', () => {
    const qr = resolve()
    expect(qr).toMatchObject({ kind: 'bank_app', mode: 'auto', amount: 12500 })
    const expected = buildBankPaymentQrPayload({ company: company(), invoice: invoice(), amountDue: 12500, lang: 'sv' })
    expect(qr.kind === 'bank_app' && qr.payload).toBe(expected)
    expect(qr.kind && qr.caption).toBe('Skanna med din bankapp')
  })

  it('falls back to the bank-app code for a private customer when Swish is hidden', () => {
    expect(resolve({ customer: privatePerson, company: { invoice_show_swish: false } }).kind).toBe('bank_app')
  })

  it('falls back to Swish for a business without a giro', () => {
    expect(resolve({ company: { bankgiro: null } }).kind).toBe('swish')
  })

  it('treats a missing customer as a business', () => {
    expect(resolve({ customer: null }).kind).toBe('bank_app')
  })

  it('prints none for EUR (bank app and Swish are SEK-only), and the payment link when there is one', () => {
    expect(resolve({ invoice: { currency: 'EUR' } })).toEqual({ kind: null, mode: 'auto', reason: 'currency_not_sek' })
    expect(resolve({ invoice: { currency: 'EUR', payment_link_url: LINK } })).toMatchObject({
      kind: 'payment_link',
      payload: LINK,
    })
  })

  it('prints none with the bank-app reason when no giro, no Swish and no link can print', () => {
    expect(resolve({ company: { bankgiro: null, swish: null } })).toEqual({
      kind: null,
      mode: 'auto',
      reason: 'no_printed_giro',
    })
  })

  it('reaches the link last: bank app and Swish win when they are usable', () => {
    expect(resolve({ invoice: { payment_link_url: LINK } }).kind).toBe('bank_app')
    expect(resolve({ invoice: { payment_link_url: LINK }, company: { bankgiro: null, swish: null } }).kind).toBe(
      'payment_link',
    )
  })

  it('uses the English caption on an English invoice', () => {
    expect(resolve({ lang: 'en' })).toMatchObject({ caption: INVOICE_QR_CAPTIONS.en.bank_app })
    expect(resolve({ lang: 'en', customer: privatePerson })).toMatchObject({ caption: 'Scan to pay with Swish' })
  })

  it('follows the company default when the invoice has no override', () => {
    expect(resolve({ company: { invoice_qr_mode: 'swish' } })).toMatchObject({ kind: 'swish', mode: 'swish' })
    expect(resolve({ company: { invoice_qr_mode: 'none' }, invoice: { qr_mode: 'bank_app' } }).kind).toBe('bank_app')
  })
})

describe('resolveInvoicePaymentQr: auto and a customer outside Sweden', () => {
  const danishBusiness = { customer_type: 'eu_business', country: 'DK' }

  it('prints none (foreign_customer) for a Danish business: bank app and Swish need a Swedish bank', () => {
    expect(resolve({ customer: danishBusiness })).toEqual({ kind: null, mode: 'auto', reason: 'foreign_customer' })
    expect(resolve({ customer: { customer_type: 'individual', country: 'DK' } })).toEqual({
      kind: null,
      mode: 'auto',
      reason: 'foreign_customer',
    })
  })

  it('prints the payment link for a Danish business when the invoice has one', () => {
    expect(resolve({ customer: danishBusiness, invoice: { payment_link_url: LINK } })).toMatchObject({
      kind: 'payment_link',
      mode: 'auto',
      payload: LINK,
    })
  })

  it('leaves an explicit mode alone: the user chose it', () => {
    expect(resolve({ customer: danishBusiness, invoice: withMode('bank_app') })).toMatchObject({
      kind: 'bank_app',
      mode: 'bank_app',
    })
    expect(resolve({ customer: danishBusiness, invoice: withMode('swish') })).toMatchObject({
      kind: 'swish',
      mode: 'swish',
    })
  })

  it('still gives a Swedish private customer Swish', () => {
    expect(resolve({ customer: { customer_type: 'individual', country: 'SE' } })).toMatchObject({
      kind: 'swish',
      mode: 'auto',
    })
  })

  it('treats a missing or empty country as Sweden', () => {
    expect(resolve({ customer: { customer_type: 'swedish_business', country: null } }).kind).toBe('bank_app')
    expect(resolve({ customer: { customer_type: 'individual', country: null } }).kind).toBe('swish')
    expect(resolve({ customer: { customer_type: 'swedish_business', country: '' } }).kind).toBe('bank_app')
  })

  it('reads a lower-case code or a legacy country name the way the rest of the codebase does', () => {
    expect(resolve({ customer: { customer_type: 'swedish_business', country: 'Sverige' } }).kind).toBe('bank_app')
    expect(resolve({ customer: { customer_type: 'swedish_business', country: 'Sweden' } }).kind).toBe('bank_app')
    expect(resolve({ customer: { customer_type: 'eu_business', country: 'dk' } })).toMatchObject({
      reason: 'foreign_customer',
    })
  })
})

describe('resolveInvoicePaymentQr: an explicit mode never falls back', () => {
  it('none prints none', () => {
    expect(resolve({ invoice: withMode('none') })).toEqual({ kind: null, mode: 'none', reason: 'mode_none' })
  })

  it('swish without a Swish number prints none (no_swish), not the bank-app code', () => {
    expect(resolve({ invoice: withMode('swish'), company: { swish: null } })).toEqual({
      kind: null,
      mode: 'swish',
      reason: 'no_swish',
    })
  })

  it('swish explains a hidden, an invalid or a foreign-currency Swish', () => {
    expect(resolve({ invoice: withMode('swish'), company: { invoice_show_swish: false } })).toMatchObject({
      reason: 'swish_hidden',
    })
    expect(resolve({ invoice: withMode('swish'), company: { swish: '0812345' } })).toMatchObject({
      reason: 'invalid_swish',
    })
    expect(resolve({ invoice: withMode('swish', { currency: 'EUR' }) })).toMatchObject({ reason: 'currency_not_sek' })
  })

  it('bank_app explains each missing piece', () => {
    const bankApp = (companyOverrides: Partial<CompanySettings>, invoiceOverrides: Partial<Invoice> = {}) =>
      resolve({ invoice: withMode('bank_app', invoiceOverrides), company: companyOverrides })
    expect(bankApp({ bankgiro: null })).toMatchObject({ kind: null, reason: 'no_printed_giro' })
    expect(bankApp({ invoice_show_bankgiro: false })).toMatchObject({ reason: 'no_printed_giro' })
    expect(bankApp({ bankgiro: '5050-1056' })).toMatchObject({ reason: 'invalid_giro' })
    expect(bankApp({ org_number: null })).toMatchObject({ reason: 'no_org_number' })
    expect(bankApp({}, { invoice_number: null, status: 'draft' })).toMatchObject({ reason: 'no_invoice_number' })
    expect(bankApp({}, { currency: 'USD' })).toMatchObject({ reason: 'currency_not_sek' })
    expect(bankApp({ company_name: '' })).toMatchObject({ reason: 'incomplete_details' })
  })

  it('bank_app pays to a printed plusgiro when the bankgiro is hidden', () => {
    const qr = resolve({
      invoice: withMode('bank_app'),
      company: { invoice_show_bankgiro: false, plusgiro: '123456-6' },
    })
    expect(qr.kind).toBe('bank_app')
    expect(qr.kind && (JSON.parse(qr.payload) as { pt: string }).pt).toBe('PG')
  })

  it('payment_link prints the link, or none without one', () => {
    expect(resolve({ invoice: withMode('payment_link', { payment_link_url: LINK }) })).toMatchObject({
      kind: 'payment_link',
      payload: LINK,
      caption: 'Skanna för att betala online',
    })
    expect(resolve({ invoice: withMode('payment_link') })).toEqual({
      kind: null,
      mode: 'payment_link',
      reason: 'no_payment_link',
    })
  })
})

describe('resolveInvoicePaymentQr: what the code asks for', () => {
  it('encodes "Att betala" after a ROT/RUT deduction, not the invoice total', () => {
    const qr = resolve({ customer: privatePerson, invoice: { total: 1250, deduction_total: 625 } })
    expect(qr).toMatchObject({ kind: 'swish', amount: 625, payload: 'C1234567890;625.00;10234;0' })
  })

  it('applies öresavrundning before the deduction, like the totals block', () => {
    const qr = resolve({ customer: privatePerson, invoice: { total: 1250.49, ore_rounding: true, deduction_total: 625 } })
    expect(qr).toMatchObject({ amount: 625, payload: 'C1234567890;625.00;10234;0' })
  })

  it('encodes the remainder of a partly paid invoice, for Swish and the bank app alike', () => {
    const partly = { status: 'partially_paid' as const, paid_amount: 5000, remaining_amount: 7500 }
    expect(resolve({ customer: privatePerson, invoice: partly })).toMatchObject({
      kind: 'swish',
      amount: 7500,
      payload: 'C1234567890;7500.00;10234;0',
    })
    const bank = resolve({ invoice: partly })
    expect(bank).toMatchObject({ kind: 'bank_app', amount: 7500 })
    expect(bank.kind && (JSON.parse(bank.payload) as { due: number }).due).toBe(7500)
  })

  it('never prints a link on a partly paid invoice: its amount was fixed at creation', () => {
    const partly = { status: 'partially_paid' as const, paid_amount: 5000, remaining_amount: 7500, payment_link_url: LINK }
    expect(resolve({ invoice: withMode('payment_link', partly) })).toMatchObject({ kind: null, reason: 'partly_paid' })
  })

  it('prints none when a deduction leaves nothing to pay', () => {
    expect(resolve({ invoice: { total: 1250, deduction_total: 1250 } })).toEqual({
      kind: null,
      mode: 'auto',
      reason: 'nothing_due',
    })
  })
})

describe('resolveInvoicePaymentQr: documents that ask for no payment', () => {
  it('never prints a code on a paid, cancelled or credited invoice, whatever the mode', () => {
    for (const status of ['paid', 'cancelled', 'credited'] as const) {
      for (const mode of ['auto', 'bank_app', 'swish', 'payment_link'] as const) {
        const qr = resolve({
          customer: privatePerson,
          invoice: withMode(mode, { status, paid_amount: status === 'paid' ? 12500 : null, payment_link_url: LINK }),
        })
        expect(qr, `${status} / ${mode}`).toEqual({ kind: null, mode, reason: 'not_payable' })
      }
    }
  })

  it('never prints a code on a credit note, proforma, quote or delivery note', () => {
    expect(resolve({ invoice: { credited_invoice_id: 'inv-orig', total: -12500 } })).toMatchObject({
      kind: null,
      reason: 'not_payable',
    })
    for (const documentType of ['proforma', 'quote', 'delivery_note'] as const) {
      expect(resolve({ invoice: { document_type: documentType } }), documentType).toMatchObject({
        kind: null,
        reason: 'not_payable',
      })
    }
  })

  it.each([
    ['draft', true],
    ['sent', true],
    ['overdue', true],
    ['partially_paid', true],
    ['paid', false],
    ['cancelled', false],
    ['credited', false],
  ] as const)('status %s: the bank-app and Swish codes agree that it asks for a payment (%s)', (status, payable) => {
    const statusInvoice = {
      status,
      paid_amount: status === 'paid' ? 12500 : status === 'partially_paid' ? 5000 : null,
      remaining_amount: status === 'paid' ? 0 : status === 'partially_paid' ? 7500 : 12500,
    }
    expect(resolve({ invoice: withMode('bank_app', statusInvoice) }).kind !== null, 'bank app').toBe(payable)
    expect(resolve({ invoice: withMode('swish', statusInvoice) }).kind !== null, 'Swish').toBe(payable)
  })
})

describe('describeInvoicePaymentQr', () => {
  it('names the kind, or none with the reason', () => {
    expect(describeInvoicePaymentQr(resolve())).toBe('bank_app')
    expect(describeInvoicePaymentQr(resolve({ invoice: withMode('none') }))).toBe('none:mode_none')
  })
})
