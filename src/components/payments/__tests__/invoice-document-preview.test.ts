import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAgainstDocument } from '@/lib/payments/orders/invoice-document'
import { paymentFromOrder, paymentFromPreviewLine } from '../InvoiceDocumentPreview'
import type { PaymentOrder, PreparedPreviewLine } from '../payments-client'

/**
 * The pay dialog (a dry-run line) and the approve dialog (an order from the
 * list) show the same invoice beside the same payment: both map to one shape,
 * and the comparison reads the account and reference the bank gets.
 */

const DOC = '5b1f4b8e-8f0e-4d3a-9b7c-2a1e6f0c9d11'

const ROOT = path.resolve(__dirname, '../../..')
const messages = (locale: 'sv' | 'en') =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')) as Record<string, Record<string, string>>)
    .bank_payments_document

function order(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
  return {
    id: 'order-1',
    supplier_invoice_id: 'inv-1',
    status: 'draft',
    amount: 737.5,
    currency: 'SEK',
    requested_execution_date: '2026-10-20',
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    payee_name: 'Derome Bygg AB',
    reference_type: 'ocr',
    reference: '4400112233',
    supplier_invoice: {
      id: 'inv-1',
      supplier_invoice_number: 'F-17',
      due_date: '2026-10-20',
      supplier: { name: 'Derome Bygg AB' },
      document_id: DOC,
      payee_bankgiro: '5402-0102',
      payment_reference: '4400112233',
      total: 737.5,
      currency: 'SEK',
      document: { mime_type: 'application/pdf', file_name: 'derome.pdf' },
    },
    ...overrides,
  } as PaymentOrder
}

describe('paymentFromOrder', () => {
  it('reads the order as paid and its invoice as the document states it', () => {
    const payment = paymentFromOrder(order())
    expect(payment).toMatchObject({
      key: 'order-1',
      supplier: 'Derome Bygg AB',
      invoiceLabel: 'F-17',
      payee: 'BG 5050-1055',
      reference: { type: 'ocr', value: '4400112233' },
      amount: 737.5,
      facts: { document_id: DOC, payee: 'BG 5402-0102', reference: '4400112233', mime_type: 'application/pdf' },
    })
    // The card is paid while the document states another bankgiro: the approver sees it.
    expect(checkAgainstDocument({ payee: payment.payee, reference: payment.reference.value }, payment.facts!)).toEqual({ payee: 'differs', reference: 'same' })
  })

  it('has no facts for an order without an invoice', () => {
    expect(paymentFromOrder(order({ supplier_invoice: null })).facts).toBeNull()
  })
})

describe('paymentFromPreviewLine', () => {
  it('takes the dry run line and its document as answered', () => {
    const line = {
      supplier_invoice_id: 'inv-1',
      supplier_name: 'Derome Bygg AB',
      supplier_invoice_number: 'F-17',
      amount: 737.5,
      currency: 'SEK',
      requested_execution_date: '2026-10-20',
      date_moved_from: null,
      payee: { type: 'bankgiro', label: 'BG 5050-1055', source: 'supplier' },
      reference: { type: 'ocr', value: '4400112233' },
      warnings: [],
      alternative_payee: null,
      document: {
        document_id: DOC,
        mime_type: null,
        file_name: null,
        payee: 'BG 5050-1055',
        reference: '4400112233',
        amount: 737.5,
        currency: 'SEK',
        due_date: '2026-10-20',
        checks: { payee: 'same', reference: 'same' },
      },
    } satisfies PreparedPreviewLine
    expect(paymentFromPreviewLine(line, 'Derome Bygg AB F-17')).toMatchObject({ key: 'inv-1', invoiceLabel: 'Derome Bygg AB F-17', facts: { document_id: DOC } })
    expect(paymentFromPreviewLine({ ...line, document: undefined }).facts).toBeNull()
  })
})

describe('bank_payments_document strings', () => {
  it('has every key in both locales, and the difference names what the invoice says', () => {
    expect(Object.keys(messages('en')).sort()).toEqual(Object.keys(messages('sv')).sort())
    expect(messages('sv').states).toBe('Fakturan anger {value}')
  })
})
