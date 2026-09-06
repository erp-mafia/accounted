import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { NON_ISSUED_INVOICE_STATUSES_FILTER } from '@/lib/invoices/matchable-statuses'
import { MAX_CHAIN_WALK } from './correction-chain'

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
  // Issued invoices only: a draft or cancelled invoice is no underlag, and the
  // verifikat page counts these references as underlag (same verdict as the
  // missing-underlag surfaces: NON_ISSUED_INVOICE_STATUSES).
  const directInvoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase.from('invoices').select('id, invoice_number')
      .eq('company_id', companyId).eq('journal_entry_id', journalEntryId)
      .not('status', 'in', NON_ISSUED_INVOICE_STATUSES_FILTER)
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
        .not('status', 'in', NON_ISSUED_INVOICE_STATUSES_FILTER)
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
 * to an ISSUED invoice are present: a draft or cancelled invoice is no
 * document, so it cannot back a verifikat (NON_ISSUED_INVOICE_STATUSES, the
 * counterpart of the anchored-document requirement on the supplier arm).
 * Every query is company-scoped (defense in depth alongside RLS).
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
        .not('status', 'in', NON_ISSUED_INVOICE_STATUSES_FILTER)
        .order('id', { ascending: true }).range(from, to),
  )
  for (const row of direct) add(row.journal_entry_id, row.id)

  // The invoice's status rides along as an inner embed so the filter drops
  // payment rows of non-issued invoices server-side (one query, no id list).
  const payments = await fetchAllRows<{
    id: string
    invoice_id: string | null
    journal_entry_id: string | null
  }>(({ from, to }) =>
    supabase.from('invoice_payments').select('id, invoice_id, journal_entry_id, invoices!inner(status)')
      .eq('company_id', companyId).in('journal_entry_id', ids)
      .not('invoices.status', 'in', NON_ISSUED_INVOICE_STATUSES_FILTER)
      .order('id', { ascending: true }).range(from, to),
  )
  for (const row of payments) add(row.journal_entry_id, row.invoice_id)

  return result
}

/**
 * Source types the invoice engine writes with `source_id` = the id of the
 * register invoice (an `invoices` row; credit notes are rows there too) that
 * the entry books: issuance and payment under faktureringsmetoden, the
 * kontantmetod inbetalning, a credit note, and a reminder fee. For these the
 * entry's own source columns are the link; no invoice-side row is needed.
 * `rot_rut_payout` is deliberately absent: its source_id is the ROT/RUT
 * request, not an invoice.
 */
export const INVOICE_SOURCED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'invoice_created',
  'invoice_paid',
  'invoice_cash_payment',
  'credit_note',
  'reminder_fee',
])

/** Ids per PostgREST `.in()` filter (URL-length convention, lib/worklist/categories.ts). */
export const LINK_LOOKUP_CHUNK = 100

/** The columns {@link getInvoicesExplainingJournalEntries} reads off an entry. */
export interface ExplainableJournalEntry {
  id: string
  source_type: string | null
  source_id: string | null
  /** Storno: the entry this one cancels (reverseEntry / correctEntry). */
  reverses_id?: string | null
  /** Rättelse: the entry this one replaces (correctEntry). */
  correction_of_id?: string | null
}

/** Literal select for the parent rows the chain walk fetches. */
const CHAIN_COLUMNS = 'id, source_type, source_id, reverses_id, correction_of_id'

/**
 * Which register invoices explain each of the given journal entries, through
 * every link the register keeps:
 *
 *   1. the engine's own entries: source_id IS the invoice id
 *      (INVOICE_SOURCED_ENTRY_TYPES);
 *   2. the invoice side: invoices.journal_entry_id and
 *      invoice_payments.journal_entry_id (getInvoiceReferencesForJournalEntries);
 *   3. the rättelse chain: a storno or correction carries reverses_id /
 *      correction_of_id and is explained by whatever explains the entry it
 *      cancels or replaces. Neither writer leaves a usable link of its own on
 *      the new entry (reverseEntry copies the original's polymorphic
 *      source_id, correctEntry copies nothing, and the register never points
 *      at a storno), so the chain is walked upwards until an attribution is
 *      found: the same links correctionChainDepth trusts, under the same
 *      MAX_CHAIN_WALK cap.
 *
 * A reader that followed only 1 and 2 kept a reversed original in its totals
 * and dropped the storno that nets it (#2351): a makulerad EU sale stayed in
 * the periodisk sammanställning while the account-based ruta 39 was zero.
 *
 * Values are invoice ids per entry id; an entry is present only when at least
 * one invoice explains it. An engine entry is attributed by its source_id
 * whether or not that invoice still exists (a missing one is a data defect
 * for the caller to report, not a reason for silence), and a chain entry
 * inherits its root's attribution the same way. An explicit link on the entry
 * itself wins over an inherited one. Parents are fetched by id, company
 * scoped and chunked, so the storno of a May invoice booked in June is
 * resolved from June's entries alone.
 */
export async function getInvoicesExplainingJournalEntries(
  supabase: SupabaseClient,
  companyId: string,
  entries: readonly ExplainableJournalEntry[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (entries.length === 0) return result

  // Chain entries waiting for their parent's attribution, by parent id.
  const waitingOn = new Map<string, string[]>()
  // Links between an attributed entry and the root that explains it: 0 for
  // an entry attributed by its own source_id or invoice-side link.
  const depthOf = new Map<string, number>()
  // Every id considered so far (the batch plus fetched parents): a cycle, or
  // a parent shared by several children, is never fetched twice.
  const seen = new Set<string>(entries.map((e) => e.id))

  // Attribute an entry and every descendant waiting on it. Iterative, so a
  // pathological in-batch chain cannot exhaust the stack, and with the depth
  // carried along: a descendant more than MAX_CHAIN_WALK links below the root
  // resolves to "no invoice", the cap the fetched walk below applies, so an
  // in-batch chain and an out-of-batch chain of the same length agree.
  const assign = (entryId: string, invoiceIds: string[], depth: number): void => {
    const queue: [string, number][] = [[entryId, depth]]
    for (let i = 0; i < queue.length; i++) {
      const [id, d] = queue[i]
      if (result.has(id)) continue
      result.set(id, i === 0 ? invoiceIds : [...invoiceIds])
      depthOf.set(id, d)
      if (d >= MAX_CHAIN_WALK) continue
      for (const child of waitingOn.get(id) ?? []) queue.push([child, d + 1])
    }
  }

  let frontier: ExplainableJournalEntry[] = [...entries]
  for (let hop = 0; frontier.length > 0; hop++) {
    const unresolved: ExplainableJournalEntry[] = []
    for (const entry of frontier) {
      if (entry.source_id && INVOICE_SOURCED_ENTRY_TYPES.has(entry.source_type ?? '')) {
        assign(entry.id, [entry.source_id], 0)
      } else {
        unresolved.push(entry)
      }
    }

    for (const ids of chunk(unresolved.map((e) => e.id), LINK_LOOKUP_CHUNK)) {
      const refs = await getInvoiceReferencesForJournalEntries(supabase, companyId, ids)
      for (const [entryId, invoiceIds] of refs) assign(entryId, invoiceIds, 0)
    }

    const parentIds: string[] = []
    for (const entry of unresolved) {
      if (result.has(entry.id)) continue
      const parentId = entry.correction_of_id ?? entry.reverses_id ?? null
      if (!parentId) continue
      const inherited = result.get(parentId)
      if (inherited) {
        const depth = (depthOf.get(parentId) ?? 0) + 1
        if (depth <= MAX_CHAIN_WALK) assign(entry.id, [...inherited], depth)
        continue
      }
      const waiting = waitingOn.get(parentId)
      if (waiting) waiting.push(entry.id)
      else waitingOn.set(parentId, [entry.id])
      if (!seen.has(parentId)) {
        seen.add(parentId)
        parentIds.push(parentId)
      }
    }
    if (parentIds.length === 0 || hop >= MAX_CHAIN_WALK) break

    frontier = []
    for (const ids of chunk(parentIds, LINK_LOOKUP_CHUNK)) {
      const parents = await fetchAllRows<ExplainableJournalEntry>(({ from, to }) =>
        supabase.from('journal_entries').select(CHAIN_COLUMNS)
          .eq('company_id', companyId).in('id', ids)
          .order('id', { ascending: true }).range(from, to),
      )
      frontier.push(...parents)
    }
  }

  return result
}
