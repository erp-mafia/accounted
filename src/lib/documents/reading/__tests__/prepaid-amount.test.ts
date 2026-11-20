/**
 * A document that deducts what was settled before this payment (an applied
 * account balance, a credit, a deposit) is due the total less that amount
 * (BT-115 = BT-112 - BT-113), while the total stays what is booked
 * (crm#1518). Every name and number is made up.
 */
import { describe, expect, it } from 'vitest'
import { prepaidDeduction, projectExtraction } from '../assemble'
import { resolveDocumentReading, type ReadingDocumentRow, type ReadingItemRow } from '../resolve'
import { bankMatchFacts } from '@/lib/documents/bank-match/facts'
import { mergeInboxItemFields } from '@/lib/documents/inbox-item-actions'
import { keepPersonCorrections } from '@/lib/documents/person-corrections'
import { AgentExtractionSchema, ExtractionSchema } from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { peppolDocumentToExtraction } from '@/lib/invoices/peppol-inbox-delivery'
import type { InvoiceExtractionResult } from '@/types'
import { receiptExtraction } from './fixtures'

const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** A hosting receipt in USD paid entirely from the account's prepaid balance: Total 7.75, Applied balance -7.75, Amount due 0.00. */
function appliedBalanceReceipt(totals: Partial<InvoiceExtractionResult['totals']> = {}): InvoiceExtractionResult {
  return receiptExtraction({
    supplier: { name: 'Exempel Hosting Inc.', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null, iban: null, bic: null },
    invoice: { invoiceNumber: 'R-1001', invoiceDate: '2026-10-01', dueDate: null, paymentReference: null, currency: 'USD', creditedInvoiceNumber: null },
    lineItems: [{ description: 'Usage', quantity: 1, unitPrice: 7.75, lineTotal: 7.75, vatRate: 0, accountSuggestion: null }],
    totals: { subtotal: 7.75, vatAmount: 0, total: 7.75, roundingAmount: null, prepaidAmount: 7.75, ...totals },
    vatBreakdown: [],
  })
}

function readingOf(extraction: InvoiceExtractionResult) {
  const item: ReadingItemRow = {
    id: ITEM_ID,
    document_id: DOC_ID,
    source: 'upload',
    extracted_data: JSON.parse(JSON.stringify(extraction)),
    extraction_skipped: false,
    kind_hint: null,
    channel_context: null,
    email_from: null,
    email_received_at: null,
    matched_supplier_id: null,
  }
  const document: ReadingDocumentRow = {
    id: DOC_ID,
    mime_type: 'application/pdf',
    file_name: 'receipt.pdf',
    upload_source: 'file_upload',
    doc_type: null,
    extracted_data: extraction as unknown as Record<string, unknown>,
    extraction_model: 'claude-sonnet-4-6',
    extracted_at: '2026-10-02T10:00:00.000Z',
    model_reading: null,
  }
  return resolveDocumentReading({ item, document, peppol: null, peppolToExtraction: peppolDocumentToExtraction, arkiv: null, supplier: null })
}

describe('the amount due of a document that deducts a prepaid amount (crm#1518)', () => {
  it('reads a receipt paid from an applied balance as due nothing', () => {
    expect(projectExtraction(appliedBalanceReceipt()).amount_due_for_payment).toBe(0)
  })

  it('subtracts a partial deposit and keeps the total to book', () => {
    const extraction = receiptExtraction({
      documentKind: 'supplier_invoice',
      totals: { subtotal: 1000, vatAmount: 250, total: 1250, roundingAmount: null, prepaidAmount: 250 },
    })
    expect(projectExtraction(extraction).amount_due_for_payment).toBe(1000)
    expect(extraction.totals.total).toBe(1250)
  })

  it('reads the deduction the same whichever sign it was printed with', () => {
    expect(projectExtraction(appliedBalanceReceipt({ prepaidAmount: -7.75 })).amount_due_for_payment).toBe(0)
  })

  it('moves a credit note toward zero', () => {
    expect(prepaidDeduction({ total: -500, prepaidAmount: 100 })).toBe(-100)
    expect(projectExtraction({ totals: { total: -500, prepaidAmount: 100 } }).amount_due_for_payment).toBe(-400)
  })

  it('ignores a deduction larger than the total, and reads the total as before without one', () => {
    expect(projectExtraction(appliedBalanceReceipt({ prepaidAmount: 9 })).amount_due_for_payment).toBe(7.75)
    expect(projectExtraction(appliedBalanceReceipt({ prepaidAmount: null })).amount_due_for_payment).toBe(7.75)
    expect(projectExtraction(receiptExtraction()).amount_due_for_payment).toBe(148)
    expect(projectExtraction({ totals: { total: 7.755 } }).amount_due_for_payment).toBe(7.755)
  })

  it('expects no bank payment for a receipt the balance settled, and the partial rest for a deposit', () => {
    expect(bankMatchFacts(readingOf(appliedBalanceReceipt()), null, '2026-10-02')).toBeNull()
    const facts = bankMatchFacts(readingOf(appliedBalanceReceipt({ prepaidAmount: 2.75 })), null, '2026-10-02')
    expect(facts).toMatchObject({ kind: 'receipt', direction: 'out', amount: 5, currency: 'USD' })
  })

  it('still lets the VAT breakdown corroborate an amount due that a deposit reduced', () => {
    const extraction = receiptExtraction({
      totals: { subtotal: 134.86, vatAmount: 13.14, total: 148, roundingAmount: 0, prepaidAmount: 48 },
    })
    const reading = readingOf(extraction)
    expect(reading.fields.amount_due_for_payment).toMatchObject({ value: 100, evidence: 'stark', corroborated_by: ['vat_breakdown'] })
    expect(reading.fields.vat_breakdown).toMatchObject({ evidence: 'stark' })
  })
})

describe('a person who types the amount due on a document with a prepaid deduction', () => {
  it('sets the amount due: the hand-set total drops the read deduction', () => {
    const merged = mergeInboxItemFields(appliedBalanceReceipt(), { totals: { total: 7.75 } })
    expect(merged.totals).toMatchObject({ total: 7.75, prepaidAmount: null })
    expect(projectExtraction(merged).amount_due_for_payment).toBe(7.75)
  })

  it('leaves a reading without a deduction exactly as before', () => {
    const merged = mergeInboxItemFields(receiptExtraction(), { totals: { total: 150 } })
    expect(merged.totals).not.toHaveProperty('prepaidAmount')
  })

  it("keeps the person's amount due over a new reading's deduction", () => {
    const corrected = mergeInboxItemFields(receiptExtraction(), { totals: { total: 7.75 } })
    const next = keepPersonCorrections(corrected, appliedBalanceReceipt())
    expect(next.totals).toMatchObject({ total: 7.75, prepaidAmount: null })
  })
})

describe('the extraction schemas', () => {
  it('carry prepaidAmount for the model and an agent, and still take a reading without it', () => {
    expect(ExtractionSchema.parse(appliedBalanceReceipt()).totals.prepaidAmount).toBe(7.75)
    expect(AgentExtractionSchema.parse(appliedBalanceReceipt()).totals.prepaidAmount).toBe(7.75)
    expect(ExtractionSchema.parse(receiptExtraction()).totals).not.toHaveProperty('prepaidAmount')
    expect(ExtractionSchema.parse(appliedBalanceReceipt({ prepaidAmount: 'none' as unknown as number })).totals.prepaidAmount).toBeNull()
  })
})
