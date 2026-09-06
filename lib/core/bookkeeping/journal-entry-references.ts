import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * A followable reference from a verifikation back to its underlag: the customer
 * or supplier invoice that identifies what the affärshändelse avser and who the
 * motpart is.
 *
 * Surfacing these makes the verifieringskedja traceable from the verifikat side,
 * not only from the invoice side (BFL 5 kap 7§: hänvisning till underlag;
 * BFNAR 2013:2: the verification chain must be followable in both directions).
 *
 * Bank transactions are deliberately excluded: a bank line is the trace of the
 * affärshändelse, not its underlag. Counting it as underlag would wrongly silence
 * the "saknar underlag" warning for expenses that still genuinely need a kvitto.
 */
export type UnderlagReferenceType = 'invoice' | 'supplier_invoice'

export interface UnderlagReference {
  type: UnderlagReferenceType
  id: string
  /** invoice_number / supplier_invoice_number: the UI builds the label from this. */
  number: string
  /**
   * Retained source document owned by a referenced supplier invoice, if any.
   *
   * Set ONLY when the document is anchored to a journal entry
   * (document_attachments.journal_entry_id IS NOT NULL), because that is the
   * exact condition every missing-underlag surface uses: the
   * verifikat_without_documents / transactions_without_documents RPCs,
   * /api/documents/counts and the transactions list all require an anchored
   * doc, since only anchored docs sit behind the WORM deletion guards. Handing
   * out a floating doc here made the verifikat view display an underlag while
   * the list kept warning "Underlag saknas" on the same row (support case
   * 2026-07-27). The reference itself is still returned either way, so the
   * verifieringskedja stays followable; only the attachment claim is withheld.
   */
  document_id?: string
}

interface InvoiceRow {
  id: string
  invoice_number: string
}

interface SupplierInvoiceRow {
  id: string
  supplier_invoice_number: string
  document_id?: string | null
  /** Embedded document row; see UnderlagReference.document_id for why. */
  document?: { journal_entry_id: string | null } | { journal_entry_id: string | null }[] | null
}

/** Columns every supplier-invoice lookup below needs, incl. the anchor check. */
const SUPPLIER_INVOICE_COLUMNS =
  'id, supplier_invoice_number, document_id, document:document_attachments(journal_entry_id)'

/**
 * A supplier invoice's document only counts as this verifikation's underlag
 * when it is anchored to a journal entry: an unanchored doc is outside the WORM
 * deletion guards, so the missing-underlag surfaces refuse to accept it and
 * this resolver must refuse too.
 */
function anchoredDocumentId(row: SupplierInvoiceRow): string | undefined {
  if (!row.document_id) return undefined
  const document = Array.isArray(row.document) ? row.document[0] : row.document
  return document?.journal_entry_id ? row.document_id : undefined
}

/**
 * Resolve every customer/supplier invoice linked to a verifikation, across all
 * the deterministic FK paths the engine uses to book one:
 *   - invoices.journal_entry_id                    (faktureringsmetod registration / direct)
 *   - invoice_payments.journal_entry_id            (kontantmetod inbetalning / delbetalning)
 *   - supplier_invoices.registration_journal_entry_id / payment_journal_entry_id
 *   - supplier_invoice_payments.journal_entry_id   (delbetalning)
 *
 * Every query is company-scoped (defense in depth alongside RLS). Results are
 * deduplicated by id, so an invoice reachable via several paths appears once.
 */
export async function getJournalEntryUnderlagReferences(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<UnderlagReference[]> {
  // --- Customer invoices ---------------------------------------------------
  const invoices = new Map<string, string>()

  // Direct link (faktureringsmetod registration, or invoices.journal_entry_id).
  const directInvoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase.from('invoices').select('id, invoice_number')
      .eq('company_id', companyId).eq('journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )

  for (const inv of (directInvoices ?? []) as InvoiceRow[]) {
    invoices.set(inv.id, inv.invoice_number)
  }

  // Payment rows (kontantmetod inbetalning, partial payments) → invoice_payments.
  const paymentRows = await fetchAllRows<{ id: string; invoice_id: string | null }>(({ from, to }) =>
    supabase.from('invoice_payments').select('id, invoice_id')
      .eq('journal_entry_id', journalEntryId).order('id', { ascending: true }).range(from, to),
  )

  const paymentInvoiceIds = new Set<string>()
  for (const row of (paymentRows ?? []) as { invoice_id: string | null }[]) {
    if (row.invoice_id && !invoices.has(row.invoice_id)) paymentInvoiceIds.add(row.invoice_id)
  }

  if (paymentInvoiceIds.size > 0) {
    const paidInvoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
      supabase.from('invoices').select('id, invoice_number')
        .eq('company_id', companyId).in('id', Array.from(paymentInvoiceIds))
        .order('id', { ascending: true }).range(from, to),
    )

    for (const inv of (paidInvoices ?? []) as InvoiceRow[]) {
      invoices.set(inv.id, inv.invoice_number)
    }
  }

  // --- Supplier invoices ---------------------------------------------------
  const supplierInvoices = new Map<string, { number: string; documentId?: string }>()

  // Registration booking (accrual) on the invoice itself.
  const registrationLinks = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
    supabase.from('supplier_invoices').select(SUPPLIER_INVOICE_COLUMNS)
      .eq('company_id', companyId).eq('registration_journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )

  for (const si of (registrationLinks ?? []) as SupplierInvoiceRow[]) {
    const documentId = anchoredDocumentId(si)
    supplierInvoices.set(si.id, {
      number: si.supplier_invoice_number,
      ...(documentId ? { documentId } : {}),
    })
  }

  // Payment booking on the invoice itself.
  const paymentLinks = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
    supabase.from('supplier_invoices').select(SUPPLIER_INVOICE_COLUMNS)
      .eq('company_id', companyId).eq('payment_journal_entry_id', journalEntryId)
      .order('id', { ascending: true }).range(from, to),
  )

  for (const si of (paymentLinks ?? []) as SupplierInvoiceRow[]) {
    const documentId = anchoredDocumentId(si)
    supplierInvoices.set(si.id, {
      number: si.supplier_invoice_number,
      ...(documentId ? { documentId } : {}),
    })
  }

  // Partial-payment rows → supplier_invoice_payments.
  const supplierPaymentRows = await fetchAllRows<{ id: string; supplier_invoice_id: string | null }>(
    ({ from, to }) => supabase.from('supplier_invoice_payments').select('id, supplier_invoice_id')
      .eq('journal_entry_id', journalEntryId).order('id', { ascending: true }).range(from, to),
  )

  const supplierPaymentIds = new Set<string>()
  for (const row of (supplierPaymentRows ?? []) as { supplier_invoice_id: string | null }[]) {
    if (row.supplier_invoice_id && !supplierInvoices.has(row.supplier_invoice_id)) {
      supplierPaymentIds.add(row.supplier_invoice_id)
    }
  }

  if (supplierPaymentIds.size > 0) {
    const paidSupplierInvoices = await fetchAllRows<SupplierInvoiceRow>(({ from, to }) =>
      supabase.from('supplier_invoices').select(SUPPLIER_INVOICE_COLUMNS)
        .eq('company_id', companyId).in('id', Array.from(supplierPaymentIds))
        .order('id', { ascending: true }).range(from, to),
    )

    for (const si of (paidSupplierInvoices ?? []) as SupplierInvoiceRow[]) {
      const documentId = anchoredDocumentId(si)
      supplierInvoices.set(si.id, {
        number: si.supplier_invoice_number,
        ...(documentId ? { documentId } : {}),
      })
    }
  }

  // --- Assemble ------------------------------------------------------------
  const references: UnderlagReference[] = []
  for (const [id, number] of invoices) references.push({ type: 'invoice', id, number })
  for (const [id, supplierInvoice] of supplierInvoices) {
    references.push({
      type: 'supplier_invoice',
      id,
      number: supplierInvoice.number,
      ...(supplierInvoice.documentId ? { document_id: supplierInvoice.documentId } : {}),
    })
  }
  return references
}

/**
 * Batch form of the customer-invoice arm above, for the surfaces that decide
 * "saknar underlag" for many verifikat at once: which register invoices point
 * at each of the given journal entries, through the two links the register
 * keeps (invoices.journal_entry_id for the registration booking,
 * invoice_payments.journal_entry_id for a kontantmetod inbetalning, a
 * delbetalning, or "matcha mot befintligt verifikat").
 *
 * An entry that appears in the result is backed by that invoice under BFL
 * 5 kap 7 § (hänvisning till underlag): the invoice Accounted issued is the
 * verifikation for the sale, and the payment row identifies the inbetalning.
 * This is the TS mirror of the customer arm in the verifikat_without_documents
 * / transactions_without_documents RPCs (migration 20260906135702, #2298):
 * every TS surface (journal-list filter, documents/counts, transactions list)
 * must reach the same verdict as the dashboard badge and the MCP tools.
 *
 * Values are invoice ids per journal entry id, direct link first and then
 * payment rows in id order, deduplicated. Only entries with at least one link
 * are present. Every query is company-scoped (defense in depth alongside RLS).
 *
 * Callers pass at most one PostgREST `.in()` chunk (the ~150-id URL-length
 * convention in lib/worklist/categories.ts). The two queries run in a fixed
 * order (invoices, then invoice_payments) so queued test mocks stay simple.
 */
export async function getInvoiceReferencesForJournalEntries(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (journalEntryIds.length === 0) return result
  const ids = [...journalEntryIds]

  const add = (journalEntryId: string | null | undefined, invoiceId: string | null | undefined) => {
    if (!journalEntryId || !invoiceId) return
    const list = result.get(journalEntryId)
    if (!list) result.set(journalEntryId, [invoiceId])
    else if (!list.includes(invoiceId)) list.push(invoiceId)
  }

  const direct = await fetchAllRows<{ id: string; journal_entry_id: string | null }>(
    ({ from, to }) =>
      supabase.from('invoices').select('id, journal_entry_id')
        .eq('company_id', companyId).in('journal_entry_id', ids)
        .order('id', { ascending: true }).range(from, to),
  )
  for (const row of direct) add(row.journal_entry_id, row.id)

  const payments = await fetchAllRows<{
    id: string
    invoice_id: string | null
    journal_entry_id: string | null
  }>(({ from, to }) =>
    supabase.from('invoice_payments').select('id, invoice_id, journal_entry_id')
      .eq('company_id', companyId).in('journal_entry_id', ids)
      .order('id', { ascending: true }).range(from, to),
  )
  for (const row of payments) add(row.journal_entry_id, row.invoice_id)

  return result
}
