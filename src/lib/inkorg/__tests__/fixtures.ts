import type { InkorgItem } from '../items'

/** An inbox item as GET /items answers it: received, unread, from an upload. Override what a test is about. */
export function makeItem(overrides: Partial<InkorgItem> = {}): InkorgItem {
  return {
    id: 'item-1',
    status: 'received',
    source: 'upload',
    created_at: '2026-10-01T09:00:00.000Z',
    channel_context: null,
    document_id: 'doc-1',
    extracted_data: null,
    kind_hint: null,
    routed_to_arkiv_at: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    matched_transaction_journal_entry_id: null,
    underlag_status: null,
    email_from: null,
    email_subject: null,
    error_message: null,
    ...overrides,
  }
}

type Extraction = NonNullable<InkorgItem['extracted_data']>

/** A reading with only what a test sets; everything else empty. */
export function reading(overrides: {
  supplier?: Partial<Extraction['supplier']>
  invoice?: Partial<Extraction['invoice']>
  totals?: Partial<Extraction['totals']>
  documentKind?: Extraction['documentKind']
  payment?: Extraction['payment']
  prominentAmounts?: Extraction['prominentAmounts']
} = {}): Extraction {
  return {
    supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null, iban: null, bic: null, ...overrides.supplier },
    invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, paymentReference: null, currency: 'SEK', ...overrides.invoice },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null, ...overrides.totals },
    vatBreakdown: [],
    confidence: 0.9,
    documentKind: overrides.documentKind ?? null,
    payment: overrides.payment ?? null,
    prominentAmounts: overrides.prominentAmounts,
  } as Extraction
}
