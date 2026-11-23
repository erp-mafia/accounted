/**
 * payment_reference / payment_reference_type (crm#1886): the reference a
 * customer invoice asks the payer to quote, as a field of the v1 and MCP
 * invoice reads and of invoice.sent. It is the reference the PDF prints, so
 * these tests hold the field against the PDF's own payment rows.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { companyWithInvoicePaymentAccount } from '@/lib/cash-accounts/invoice-payment-accounts'
import {
  invoicePaymentReferenceFields,
  withPaymentReference,
  type PaymentReferenceFacts,
  type PaymentReferenceRow,
} from '@/lib/invoices/payment-reference-fields'
import { buildInvoicePaymentRows } from '@/lib/invoices/payment-rows'
import { createTableMockSupabase, makeCompanySettings, type TableMockResult } from '@/tests/helpers'
import type { CompanySettings, Currency } from '@/types'

const BANKGIRO = '5050-1055'
const NONE = { payment_reference: null, payment_reference_type: null }

const invoice = (overrides: Partial<PaymentReferenceRow> = {}): PaymentReferenceRow => ({
  id: 'inv-1',
  invoice_number: '0073',
  document_type: 'invoice',
  credited_invoice_id: null,
  total: 1250,
  currency: 'SEK',
  ...overrides,
})

const withGiro = (overrides: Partial<CompanySettings> = {}) => makeCompanySettings({ bankgiro: BANKGIRO, ...overrides })

describe('invoicePaymentReferenceFields', () => {
  it('is the OCR reference of a Swedish invoice that prints a giro: the number plus its check digit', () => {
    expect(invoicePaymentReferenceFields(invoice(), {}, withGiro())).toEqual({
      payment_reference: '00737',
      payment_reference_type: 'ocr',
    })
    expect(invoicePaymentReferenceFields(invoice({ invoice_number: 'F-2026-0042' }), { language: 'sv' }, withGiro())).toEqual({
      payment_reference: '202600425',
      payment_reference_type: 'ocr',
    })
  })

  it("carries the length digit when the company's OCR prints one, as the PDF does", () => {
    const company = withGiro({ invoice_ocr_length_digit: true })
    const fields = invoicePaymentReferenceFields(invoice({ invoice_number: '1042' }), {}, company)
    expect(fields).toEqual({ payment_reference: '104265', payment_reference_type: 'ocr' })
    const printed = buildInvoicePaymentRows({
      company: companyWithInvoicePaymentAccount(company, 'SEK', null),
      invoice: { invoice_number: '1042', currency: 'SEK', payment_link_url: null },
      lang: 'sv',
    }).at(-1)
    expect(printed).toMatchObject({ key: 'ocr', value: fields.payment_reference })
  })

  it('is the invoice number when the PDF prints no OCR', () => {
    const asNumber = { payment_reference: '0073', payment_reference_type: 'invoice_number' }
    // No giro to pay an OCR to.
    expect(invoicePaymentReferenceFields(invoice(), {}, makeCompanySettings())).toEqual(asNumber)
    // The company turned the OCR reference off, or hides its giro.
    expect(invoicePaymentReferenceFields(invoice(), {}, withGiro({ invoice_show_ocr: false }))).toEqual(asNumber)
    expect(invoicePaymentReferenceFields(invoice(), {}, withGiro({ invoice_show_bankgiro: false }))).toEqual(asNumber)
    // An English invoice prints "Reference" with the number.
    expect(invoicePaymentReferenceFields(invoice(), { language: 'en' }, withGiro())).toEqual(asNumber)
    // A company without a settings row prints no giro.
    expect(invoicePaymentReferenceFields(invoice(), {}, null)).toEqual(asNumber)
  })

  it("follows the invoice's own frozen payee before the company's", () => {
    // The invoice chose an account with a bankgiro; the company default has none.
    expect(
      invoicePaymentReferenceFields(invoice(), { payment_details: { bankgiro: BANKGIRO } }, makeCompanySettings()),
    ).toEqual({ payment_reference: '00737', payment_reference_type: 'ocr' })
    // The invoice chose an account without a giro; the company default has one.
    expect(
      invoicePaymentReferenceFields(invoice(), { payment_details: { iban: 'SE4550000000058398257466' } }, withGiro()),
    ).toEqual({ payment_reference: '0073', payment_reference_type: 'invoice_number' })
  })

  it('never lends the SEK giro to a foreign-currency invoice', () => {
    expect(invoicePaymentReferenceFields(invoice({ currency: 'EUR' }), {}, withGiro())).toEqual({
      payment_reference: '0073',
      payment_reference_type: 'invoice_number',
    })
  })

  it.each([
    ['a draft without a number', invoice({ invoice_number: null }), {}],
    ['a credit note linked to its original', invoice({ invoice_number: 'KR-0073', credited_invoice_id: 'inv-0', total: -1250 }), {}],
    ['a credit note imported without a link', invoice({ total: -1250 }), {}],
    ['a quote', invoice({ invoice_number: 'OF-0073', document_type: 'quote' }), {}],
    ['a proforma', invoice({ document_type: 'proforma' }), {}],
    ['a delivery note', invoice({ document_type: 'delivery_note' }), {}],
    ['an invoice Bankgirot debits by Autogiro', invoice(), { autogiro_payer_number: '4711' }],
  ] as Array<[string, PaymentReferenceRow, PaymentReferenceFacts]>)('is null on %s', (_name, row, facts) => {
    expect(invoicePaymentReferenceFields(row, facts, withGiro())).toEqual(NONE)
  })

  // The field is the reference row of the PDF and the mails, whatever the
  // settings: both come from invoicePaymentReference.
  it.each([
    ['a printed bankgiro', withGiro(), {}],
    ['a printed plusgiro', makeCompanySettings({ plusgiro: '123456-6' }), {}],
    ['no giro', makeCompanySettings(), {}],
    ['the OCR turned off', withGiro({ invoice_show_ocr: false }), {}],
    ['an English customer', withGiro(), { language: 'en' }],
    ['a payee of its own', makeCompanySettings(), { payment_details: { bankgiro: BANKGIRO } }],
  ] as Array<[string, CompanySettings, PaymentReferenceFacts]>)('equals the reference row the PDF prints with %s', (_name, company, facts) => {
    const row = invoice({ invoice_number: 'F-2026-0042' })
    const lang = facts.language === 'en' ? 'en' : 'sv'
    const printed = buildInvoicePaymentRows({
      company: companyWithInvoicePaymentAccount(company, row.currency as Currency, facts.payment_details ?? null),
      invoice: { invoice_number: row.invoice_number, currency: row.currency },
      lang,
    }).at(-1)!

    const fields = invoicePaymentReferenceFields(row, facts, company)

    expect(fields.payment_reference).toBe(printed.value)
    expect(fields.payment_reference_type).toBe(printed.key === 'ocr' ? 'ocr' : 'invoice_number')
  })
})

/** A client that answers the settings read and the read of the invoices' own facts. */
function client(answers: { settings?: TableMockResult; facts?: TableMockResult }) {
  const mock = createTableMockSupabase({
    company_settings: answers.settings ?? { data: null },
    invoices: answers.facts ?? { data: [] },
  })
  return { ...mock, supabase: mock.supabase as unknown as SupabaseClient, from: mock.supabase.from }
}

describe('withPaymentReference', () => {
  it('reads nothing when no row can carry a reference', async () => {
    const { supabase, from } = client({})
    const rows = await withPaymentReference(supabase, 'co-1', [
      invoice({ id: 'draft', invoice_number: null }),
      invoice({ id: 'credit', credited_invoice_id: 'inv-0', total: -1250 }),
      invoice({ id: 'quote', document_type: 'quote' }),
    ])
    expect(from).not.toHaveBeenCalled()
    expect(rows.map((row) => [row.id, row.payment_reference, row.payment_reference_type])).toEqual([
      ['draft', null, null],
      ['credit', null, null],
      ['quote', null, null],
    ])
  })

  it('adds the reference of each invoice from the company settings and its own facts', async () => {
    const { supabase, tables, findCall, findCalls } = client({
      settings: { data: withGiro() },
      facts: {
        data: [
          { id: 'sv', payment_details: null, autogiro_payer_number: null, customer: { language: 'sv' } },
          // PostgREST can hand an embedded row back as a one-element array.
          { id: 'en', payment_details: null, autogiro_payer_number: null, customer: [{ language: 'en' }] },
          { id: 'autogiro', payment_details: null, autogiro_payer_number: '4711', customer: { language: 'sv' } },
        ],
      },
    })

    const rows = await withPaymentReference(supabase, 'co-1', [
      invoice({ id: 'sv', invoice_number: '1042' }),
      invoice({ id: 'draft', invoice_number: null }),
      invoice({ id: 'en', invoice_number: '1043' }),
      invoice({ id: 'autogiro', invoice_number: '1044' }),
    ])

    expect(rows.map((row) => [row.id, row.payment_reference, row.payment_reference_type])).toEqual([
      ['sv', '10421', 'ocr'],
      ['draft', null, null],
      ['en', '1043', 'invoice_number'],
      ['autogiro', null, null],
    ])
    // The rows keep every column they came with.
    expect(rows[0]).toMatchObject({ id: 'sv', invoice_number: '1042', currency: 'SEK', total: 1250 })
    // One settings read, and the facts of the rows that can carry a reference only.
    expect(tables()).toEqual(['company_settings', 'invoices'])
    expect(findCalls('invoices', 'in')).toEqual([['id', ['sv', 'en', 'autogiro']]])
    expect(findCalls('invoices', 'eq')).toEqual([['company_id', 'co-1']])
    const columns = String(findCall('invoices', 'select')?.[0])
    expect(columns).toContain('autogiro_payer_number')
    expect(columns).toContain('payment_details')
    expect(columns).toContain('customer:customers(language)')
  })

  it('takes the settings row a door already holds instead of reading it', async () => {
    const { supabase, tables } = client({
      // A read would answer a company without a giro.
      settings: { data: makeCompanySettings() },
      facts: { data: [{ id: 'inv-1', payment_details: null, autogiro_payer_number: null, customer: { language: 'sv' } }] },
    })

    const [row] = await withPaymentReference(supabase, 'co-1', [invoice()], { company: withGiro() })

    expect(row).toMatchObject({ payment_reference: '00737', payment_reference_type: 'ocr' })
    expect(tables()).toEqual(['invoices'])
  })

  it('reports no reference for a row whose facts did not come back', async () => {
    const { supabase } = client({ settings: { data: withGiro() }, facts: { data: [] } })
    const [row] = await withPaymentReference(supabase, 'co-1', [invoice()])
    expect(row).toMatchObject(NONE)
  })

  it('throws instead of guessing when the settings or the facts cannot be read', async () => {
    const noSettings = client({ settings: { error: { message: 'boom' } } })
    await expect(withPaymentReference(noSettings.supabase, 'co-1', [invoice()])).rejects.toThrow(/company_settings/)

    const noFacts = client({ settings: { data: withGiro() }, facts: { error: { message: 'boom' } } })
    await expect(withPaymentReference(noFacts.supabase, 'co-1', [invoice()])).rejects.toThrow(/payment reference/)
  })
})
