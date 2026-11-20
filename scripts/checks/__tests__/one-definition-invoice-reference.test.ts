/**
 * The guards of a customer invoice's payment reference (crm#1886): which
 * reference it carries is chosen in one place, and invoice.sent is emitted
 * in one place, so the field reaches every door.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import paymentReference from '../one-definition/invoice-payment-reference.mjs'
import sentEvent from '../one-definition/invoice-sent-event.mjs'

const hits = (rule: Parameters<typeof findRuleLines>[1], line: string) => findRuleLines(line, rule).length > 0

describe.each([
  ['invoice-payment-reference', paymentReference, [
    // The choice as the PDF rows, the bank-app QR and the mailbox each made it.
    'const reference: InvoicePaymentRow = invoiceShowsOcrReference(company, lang)',
    'const ocr = invoiceShowsOcrReference(giro, language)',
    'const reference = invoiceShowsOcrReference(company, lang) ? generateOcrReference(invoiceNumber) : invoiceNumber.trim()',
  ], [
    'const { reference } = invoicePaymentReference(company, invoice.invoice_number, lang)',
    "import { invoicePaymentReference, invoicePrintsBankgiro } from '@/lib/invoices/ocr-reference'",
    // Other readers of the generator: the keys a payment is matched under, the Peppol PaymentID.
    'const ocr = normalizeOcrReference(generateOcrReference(raw))',
    "paymentId: generateOcrReference(invoice.invoice_number ?? ''),",
  ]],
  ['invoice-sent-event', sentEvent, [
    "type: 'invoice.sent',",
    "await eventBus.emit({ type: 'invoice.sent', payload: { invoice, companyId, userId } })",
    'await eventBus.emit({ type: "invoice.sent", payload })',
  ], [
    'await emitInvoiceSent({ supabase, companyId, userId, invoice: invoice as Invoice, log })',
    "eventBus.on('invoice.sent', handler)",
    "'invoice.sent': ['event-log', 'webhooks'],",
    // Other invoice events keep their own emit sites.
    "type: 'invoice.paid',",
    "type: 'invoice.created',",
  ]],
] as const)('%s', (_name, rule, written, left) => {
  it.each(written)('flags: %s', (line) => {
    expect(hits(rule, line)).toBe(true)
  })

  it.each(left)('leaves: %s', (line) => {
    expect(hits(rule, line)).toBe(false)
  })
})
