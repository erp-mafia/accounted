import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'

/**
 * Whether a document may be deleted by a person or an agent: one rule for
 * every door. deleteDocument() applies it behind DELETE /api/documents/[id],
 * the v1 operation documents.delete and its MCP tool (removeDocument), the
 * held-file discard and the invoice-delivery cleanup; the Arkiv record view
 * asks the same rule whether to offer the action (offersDocumentDelete), so
 * the UI never offers what the server refuses and never hides what it takes.
 *
 * A document is kept when:
 *
 *   - it is tied to a verifikat, at the entry or at one of its lines: it is
 *     räkenskapsinformation under BFL 7 kap 2 § and is kept for 7 years;
 *     correcting one means a new version, never a delete. The DB trigger
 *     block_document_deletion() is the backstop for the entry link.
 *   - it is the underlag of a supplier invoice or an expense claim (utlägg)
 *     whose row still exists. Any status counts: neither table has a
 *     cancelled state, a credited or reversed supplier invoice keeps its row
 *     for BFL 7 kap (20260423121000), and a registered one without a
 *     verifikat link yet (kontantmetoden, unpaid) still documents the
 *     affärshändelse its later payment voucher books (BFL 5 kap 6-7 §). Both
 *     foreign keys are ON DELETE SET NULL, so without this rule a delete
 *     would silently orphan the record. Deleting the supplier invoice or the
 *     utlägg through its own flow (allowed only while nothing is booked)
 *     removes the row and so releases the pin, on purpose.
 *   - it is the file or the received Peppol XML
 *     (channel_context.peppol_xml_document_id) of an inbox item that became a
 *     supplier invoice or a verifikat (created_supplier_invoice_id or
 *     created_journal_entry_id set). The received XML is the invoice in the
 *     form it arrived in and is kept as received (BFL 7 kap 1 §). An inbox
 *     item never booked or converted does not pin: its files can still go.
 *   - a bank transaction has it as its underlag (transactions.document_id).
 *     That foreign key is ON DELETE RESTRICT; the rule answers it up front
 *     with the same refusal the database's 23503 maps to
 *     (lib/errors/foreign-key-refusal.ts), which stays as the race backstop.
 *
 * Account erasure and sandbox or company teardown do not delete documents
 * through here: they run in SQL (anonymize_user_account, the sandbox cleanup
 * functions) and this rule does not touch them.
 */

/** What holds a document so it may not be deleted. */
export type DocumentDeleteBlock = 'verifikat' | 'supplier_invoice' | 'expense_claim' | 'booked_inbox_item' | 'bank_transaction'

/** The structured error code each block answers with (lib/errors/structured-errors.ts). */
export type DocumentDeleteRefusalCode =
  | 'DOC_DELETE_LINKED'
  | 'DOC_DELETE_SUPPLIER_INVOICE_UNDERLAG'
  | 'DOC_DELETE_EXPENSE_CLAIM_UNDERLAG'
  | 'DOC_DELETE_BOOKED_INBOX_ITEM'
  | 'DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION'

export interface DocumentDeleteRefusal {
  block: DocumentDeleteBlock
  code: DocumentDeleteRefusalCode
  /** The Swedish sentence shown to the person; the same text as the code's message_sv. */
  message: string
}

/** The records that hold a document without a verifikat link, as readDocumentDeletePins() reads them. */
export interface DocumentDeletePins {
  /** A supplier invoice has it as its underlag (supplier_invoices.document_id, ON DELETE SET NULL). */
  supplierInvoice: boolean
  /** An expense claim (utlägg) has it as its underlag (expense_claims.document_id, ON DELETE SET NULL). */
  expenseClaim: boolean
  /** A bank transaction has it as its underlag (transactions.document_id, ON DELETE RESTRICT). */
  bankTransaction: boolean
  /** Inbox items that carry it, as their file or as the received Peppol XML (channel_context.peppol_xml_document_id). */
  inboxItems: Array<{ created_journal_entry_id: string | null; created_supplier_invoice_id: string | null }>
}

export type DocumentLinks = { journal_entry_id?: string | null; journal_entry_line_id?: string | null }

export const DOCUMENT_DELETE_REFUSALS: Record<DocumentDeleteBlock, Omit<DocumentDeleteRefusal, 'block'>> = {
  verifikat: {
    code: 'DOC_DELETE_LINKED',
    message:
      'Underlaget är knutet till en verifikation och utgör räkenskapsinformation enligt Bokföringslagen 7 kap 2§. Räkenskapsinformation ska bevaras i minst 7 år och får inte raderas. Använd "Ersätt med ny version" om underlaget behöver korrigeras.',
  },
  supplier_invoice: {
    code: 'DOC_DELETE_SUPPLIER_INVOICE_UNDERLAG',
    message:
      'Underlaget hör till en registrerad leverantörsfaktura och utgör räkenskapsinformation enligt Bokföringslagen (5 kap 6-7 §§ och 7 kap). Det ska bevaras i minst 7 år och får inte raderas så länge leverantörsfakturan finns kvar.',
  },
  expense_claim: {
    code: 'DOC_DELETE_EXPENSE_CLAIM_UNDERLAG',
    message:
      'Underlaget hör till ett registrerat utlägg och utgör räkenskapsinformation enligt Bokföringslagen (5 kap 6-7 §§ och 7 kap). Det ska bevaras i minst 7 år och får inte raderas så länge utlägget finns kvar.',
  },
  booked_inbox_item: {
    code: 'DOC_DELETE_BOOKED_INBOX_ITEM',
    message:
      'Underlaget hör till en mottagen faktura som redan har bokförts eller blivit en leverantörsfaktura. Det utgör räkenskapsinformation enligt Bokföringslagen 7 kap och ska bevaras i minst 7 år i det skick det togs emot, så det får inte raderas.',
  },
  bank_transaction: {
    code: 'DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION',
    message: 'Underlaget är kopplat till en banktransaktion och kan inte tas bort. Koppla bort det från transaktionen först.',
  },
}

function refusal(block: DocumentDeleteBlock): DocumentDeleteRefusal {
  return { block, ...DOCUMENT_DELETE_REFUSALS[block] }
}

/**
 * The verifikat half of the rule: false when the document is tied to a
 * verifikat or one of its lines. It needs nothing beyond the document row, so
 * callers check it first and read the pins only for a document it lets go.
 */
export function canDeleteDocument(doc: DocumentLinks): boolean {
  return !doc.journal_entry_id && !doc.journal_entry_line_id
}

/** The whole rule: why the document may not be deleted, or null when it may. */
export function documentDeleteRefusal(doc: DocumentLinks, pins: DocumentDeletePins): DocumentDeleteRefusal | null {
  if (!canDeleteDocument(doc)) return refusal('verifikat')
  if (pins.supplierInvoice) return refusal('supplier_invoice')
  if (pins.expenseClaim) return refusal('expense_claim')
  if (pins.inboxItems.some((i) => i.created_journal_entry_id != null || i.created_supplier_invoice_id != null)) {
    return refusal('booked_inbox_item')
  }
  if (pins.bankTransaction) return refusal('bank_transaction')
  return null
}

/** Whether the Arkiv record offers "Ta bort": exactly when the server rule would take the delete. */
export function offersDocumentDelete(doc: DocumentLinks, pins: DocumentDeletePins): boolean {
  return documentDeleteRefusal(doc, pins) === null
}

/**
 * Read the records that hold a document (the pins documentDeleteRefusal()
 * weighs), scoped to the company. A failed read throws with its SQLSTATE
 * (dbError): an unknown pin never reads as "free to delete".
 */
export async function readDocumentDeletePins(supabase: SupabaseClient, companyId: string, documentId: string): Promise<DocumentDeletePins> {
  const [supplierInvoice, expenseClaim, bankTransaction, inboxFile, inboxXml] = await Promise.all([
    supabase.from('supplier_invoices').select('id').eq('company_id', companyId).eq('document_id', documentId).limit(1),
    supabase.from('expense_claims').select('id').eq('company_id', companyId).eq('document_id', documentId).limit(1),
    supabase.from('transactions').select('id').eq('company_id', companyId).eq('document_id', documentId).limit(1),
    supabase
      .from('invoice_inbox_items')
      .select('created_journal_entry_id, created_supplier_invoice_id')
      .eq('company_id', companyId)
      .eq('document_id', documentId),
    supabase
      .from('invoice_inbox_items')
      .select('created_journal_entry_id, created_supplier_invoice_id')
      .eq('company_id', companyId)
      .eq('channel_context->>peppol_xml_document_id', documentId),
  ])
  for (const r of [supplierInvoice, expenseClaim, bankTransaction, inboxFile, inboxXml]) {
    if (r.error) throw dbError(r.error, null)
  }
  type InboxPin = DocumentDeletePins['inboxItems'][number]
  const rows = (r: { data: unknown }): unknown[] => (Array.isArray(r.data) ? r.data : [])
  return {
    supplierInvoice: rows(supplierInvoice).length > 0,
    expenseClaim: rows(expenseClaim).length > 0,
    bankTransaction: rows(bankTransaction).length > 0,
    inboxItems: [...(rows(inboxFile) as InboxPin[]), ...(rows(inboxXml) as InboxPin[])],
  }
}
