import { describe, it, expect } from 'vitest'
import {
  buildEditorPaymentSummary,
  describeEditorPaymentSummary,
  paymentReason,
  paymentTermsTexts,
  type EditorPaymentSummaryInput,
} from '@/lib/invoices/editor/payment-summary'
import { makeCompanySettings } from '@/tests/helpers'
import type { CompanySettings, InvoicePaymentAccount } from '@/types'

/** Invented company: a bankgiro with a valid check digit, an org number, Swish stored but hidden. */
function settings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return makeCompanySettings({
    company_name: 'Exempelbolaget AB',
    org_number: '5566778899',
    bank_name: 'Exempelbanken',
    bankgiro: '5050-1055',
    swish: '1234567890',
    invoice_show_swish: false,
    invoice_qr_mode: 'auto',
    ...overrides,
  })
}

type InputOverrides = Omit<Partial<EditorPaymentSummaryInput>, 'invoice'> & {
  invoice?: Partial<EditorPaymentSummaryInput['invoice']>
}

function input(overrides: InputOverrides = {}): EditorPaymentSummaryInput {
  const { invoice, ...rest } = overrides
  return {
    settings: settings(),
    currency: 'SEK',
    payee: null,
    customer: { customer_type: 'swedish_business' },
    lang: 'sv',
    autoPaymentLink: false,
    ...rest,
    invoice: {
      invoice_number: '1043',
      document_type: 'invoice',
      total: 12500,
      deduction_total: 0,
      ore_rounding: true,
      qr_mode: null,
      payment_link_url: null,
      due_date: '2026-11-01',
      invoice_date: '2026-10-02',
      ...invoice,
    },
  }
}

describe('buildEditorPaymentSummary', () => {
  it('summarizes a bankgiro with OCR and the bank-app code', () => {
    const summary = buildEditorPaymentSummary(input())
    expect(summary.bankName).toBe('Exempelbanken')
    expect(summary.methods.map((row) => row.key)).toEqual(['bankgiro'])
    expect(summary.reference).toBe('ocr')
    expect(summary.qr.kind).toBe('bank_app')
    expect(summary.payeeMissing).toBe(false)
    expect(describeEditorPaymentSummary(summary)).toEqual([
      { kind: 'text', text: 'Exempelbanken' },
      { kind: 'key', key: 'method_bankgiro_ocr', values: { number: '5050-1055' } },
      { kind: 'key', key: 'qr_bank_app' },
    ])
  })

  it('names the other ways to pay after the first, and Swish first for a private person', () => {
    const summary = buildEditorPaymentSummary(
      input({ settings: settings({ invoice_show_swish: true }), customer: { customer_type: 'individual' } }),
    )
    expect(summary.qr.kind).toBe('swish')
    expect(describeEditorPaymentSummary(summary)).toEqual([
      { kind: 'text', text: 'Exempelbanken' },
      { kind: 'key', key: 'method_bankgiro_ocr', values: { number: '5050-1055' } },
      { kind: 'others', methods: ['swish'] },
      { kind: 'key', key: 'qr_swish' },
    ])
  })

  it('says Meddelande when only a bank account prints', () => {
    const summary = buildEditorPaymentSummary(
      input({ settings: settings({ bankgiro: null, clearing_number: '6123', account_number: '456789012' }) }),
    )
    expect(summary.reference).toBe('message')
    expect(summary.qr).toMatchObject({ kind: null, reason: 'no_printed_giro' })
    expect(describeEditorPaymentSummary(summary)).toEqual([
      { kind: 'text', text: 'Exempelbanken' },
      { kind: 'key', key: 'method_bank_account', values: { number: '6123-456789012' } },
      { kind: 'key', key: 'reference_message' },
    ])
  })

  it('prints the payee the invoice chose instead of the company default', () => {
    const payee: InvoicePaymentAccount = {
      bank_name: 'Andra banken',
      clearing_number: null,
      account_number: null,
      bankgiro: null,
      plusgiro: '4711-3',
      swish: null,
      iban: null,
      bic: null,
      bank_code: null,
      foreign_account_number: null,
    }
    const summary = buildEditorPaymentSummary(input({ payee }))
    expect(summary.bankName).toBe('Andra banken')
    expect(summary.methods.map((row) => row.key)).toEqual(['plusgiro'])
  })

  it('flags a missing payee, and tells hidden details from absent ones', () => {
    const none = buildEditorPaymentSummary(input({ settings: settings({ bankgiro: null, swish: null, bank_name: null }) }))
    expect(none.payeeMissing).toBe(true)
    expect(none.storedAccountUsable).toBe(false)
    expect(describeEditorPaymentSummary(none)).toEqual([])
    expect(paymentReason(none, { lang: 'sv', showOcr: true })).toBeNull()

    const hidden = buildEditorPaymentSummary(input({ settings: settings({ invoice_show_bankgiro: false }) }))
    expect(hidden.payeeMissing).toBe(true)
    expect(hidden.storedAccountUsable).toBe(true)
    expect(paymentReason(hidden, { lang: 'sv', showOcr: true })).toEqual({
      key: 'reason_details_hidden',
      action: 'open_panel',
    })
  })

  it('counts a payment link as a part, but never as the payee', () => {
    const summary = buildEditorPaymentSummary(
      input({ invoice: { payment_link_url: 'https://pay.example.com/abc' } }),
    )
    expect(summary.paymentLink).toBe('printed')
    expect(describeEditorPaymentSummary(summary)).toContainEqual({ kind: 'key', key: 'link_printed' })
    const linkOnly = buildEditorPaymentSummary(
      input({
        settings: settings({ bankgiro: null, swish: null }),
        invoice: { payment_link_url: 'https://pay.example.com/abc' },
      }),
    )
    expect(linkOnly.payeeMissing).toBe(true)
  })

  it('takes a printed payment link as payable when the stored account is hidden, as the preview does', () => {
    // The send check passes (a bankgiro is stored) and the link is a way to
    // pay that prints: preview-draft reports no missing payee, so the editor
    // must not open the payee fix on every send either.
    const summary = buildEditorPaymentSummary(
      input({
        settings: settings({ invoice_show_bankgiro: false }),
        invoice: { payment_link_url: 'https://pay.example.com/abc' },
      }),
    )
    expect(summary.methods).toEqual([])
    expect(summary.payeeMissing).toBe(false)
    expect(summary.qr.kind).toBe('payment_link')
    expect(describeEditorPaymentSummary(summary)).toEqual([
      { kind: 'key', key: 'link_printed' },
      { kind: 'key', key: 'qr_payment_link' },
    ])
    expect(paymentReason(summary, { lang: 'sv', showOcr: true })).toBeNull()
  })

  it('does not take a BIC alone as a way to pay', () => {
    const summary = buildEditorPaymentSummary(input({ settings: settings({ bankgiro: null, bic: 'ESSESESS' }) }))
    expect(summary.storedAccountUsable).toBe(true)
    expect(summary.payeeMissing).toBe(true)
  })

  it('uses the invoice qr_mode over the company setting', () => {
    const summary = buildEditorPaymentSummary(input({ invoice: { qr_mode: 'none' } }))
    expect(summary.qr).toMatchObject({ kind: null, reason: 'mode_none' })
    expect(paymentReason(summary, { lang: 'sv', showOcr: true })).toBeNull()
  })
})

describe('paymentReason', () => {
  const reason = (
    overrides: InputOverrides,
    ctx: { lang: 'sv' | 'en'; showOcr: boolean } = { lang: 'sv', showOcr: true },
  ) => paymentReason(buildEditorPaymentSummary(input(overrides)), ctx)

  it('is silent when a code prints', () => {
    expect(reason({})).toBeNull()
  })

  it('explains a missing giro, with OCR only on a Swedish invoice that shows it', () => {
    const noGiro = { settings: settings({ bankgiro: null, clearing_number: '6123', account_number: '456789012' }) }
    expect(reason(noGiro)).toEqual({ key: 'reason_no_giro_ocr', action: 'add_giro' })
    expect(reason(noGiro, { lang: 'en', showOcr: true })).toEqual({ key: 'reason_no_giro', action: 'add_giro' })
    expect(reason(noGiro, { lang: 'sv', showOcr: false })).toEqual({ key: 'reason_no_giro', action: 'add_giro' })
  })

  it('writes an IBAN in groups of four', () => {
    const summary = buildEditorPaymentSummary(
      input({
        currency: 'EUR',
        settings: settings({
          invoice_payment_accounts: {
            EUR: {
              bank_name: 'Exempelbanken',
              clearing_number: null,
              account_number: null,
              bankgiro: null,
              plusgiro: null,
              swish: null,
              iban: 'SE4550000000058398257466',
              bic: 'ESSESESS',
              bank_code: null,
              foreign_account_number: null,
            },
          },
        }),
      }),
    )
    expect(describeEditorPaymentSummary(summary)[1]).toEqual({
      kind: 'key',
      key: 'method_iban',
      values: { number: 'SE45 5000 0000 0583 9825 7466' },
    })
  })

  it('explains a foreign currency', () => {
    expect(
      reason({
        currency: 'EUR',
        settings: settings({
          invoice_payment_accounts: {
            EUR: {
              bank_name: 'Exempelbanken',
              clearing_number: null,
              account_number: null,
              bankgiro: null,
              plusgiro: null,
              swish: null,
              iban: 'SE4550000000058398257466',
              bic: 'ESSESESS',
              bank_code: null,
              foreign_account_number: null,
            },
          },
        }),
      }),
    ).toEqual({ key: 'reason_currency', action: null })
  })

  it('explains an explicit Swish choice that cannot print', () => {
    expect(reason({ invoice: { qr_mode: 'swish' } })).toEqual({ key: 'reason_swish_hidden', action: 'open_panel' })
    expect(reason({ invoice: { qr_mode: 'swish' }, settings: settings({ swish: null }) })).toEqual({
      key: 'reason_no_swish',
      action: 'open_panel',
    })
  })

  it('promises the link code at send when Stripe creates the link', () => {
    expect(
      reason({ autoPaymentLink: true, settings: settings({ bankgiro: null, clearing_number: '6123', account_number: '456789012' }) }),
    ).toEqual({ key: 'reason_link_at_send', action: null })
    expect(reason({ invoice: { qr_mode: 'payment_link' } })).toEqual({ key: 'reason_no_link', action: 'open_panel' })
  })

  it('names a missing org number', () => {
    expect(reason({ settings: settings({ org_number: null }) })).toEqual({ key: 'reason_no_org_number', action: null })
  })
})

describe('paymentTermsTexts', () => {
  it('lists the set texts, first line each', () => {
    expect(
      paymentTermsTexts({
        invoice_credit_terms_text: 'Betalning inom 30 dagar.\nAndra raden.',
        invoice_late_fee_text: '  ',
      }),
    ).toEqual(['Betalning inom 30 dagar.'])
    expect(paymentTermsTexts(null)).toEqual([])
  })
})
