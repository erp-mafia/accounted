import type { SupabaseClient } from '@supabase/supabase-js'
import { getInvoiceReferencesForJournalEntries } from '@/lib/core/bookkeeping/journal-entry-references'

/**
 * Ids per read: the supplier-invoice read puts the ids twice into one
 * PostgREST .or() filter in the URL, and 50 is the size every caller has
 * used since the counts route capped it there.
 */
export const UNDERLAG_COUNTS_CHUNK = 50

export interface UnderlagCounts {
  /** Distinct underlag documents per journal entry id; entries with none are absent. */
  counts: Record<string, number>
  /** Customer invoices referencing each journal entry id; entries with none are absent. */
  invoice_references: Record<string, number>
}

/**
 * The underlag the verifikat list shows per entry, for any number of ids
 * (read in chunks of UNDERLAG_COUNTS_CHUNK). The ids must already be
 * validated UUIDs: they go into a PostgREST .or() filter.
 *
 * `counts` counts BOTH direct attachments (document_attachments.journal_entry_id)
 * and documents retained on a supplier invoice that references the entry
 * (registration/payment FK or a supplier_invoice_payments row). BFL 5 kap 7 §
 * accepts underlag via hänvisning, and the expanded-row view
 * (JournalEntryAttachments) already lists referenced docs: counting only
 * direct links made the list warning disagree with the opened row.
 * A referenced doc counts only when ANCHORED to a journal entry
 * (journal_entry_id set): unanchored docs sit outside the WORM deletion
 * guards, so they must not silence the missing-underlag warning (mirrors the
 * verifikat_without_documents RPC). Documents are deduplicated per entry so a
 * doc that is both directly linked and referenced counts once.
 *
 * `invoice_references` counts, per entry, the customer invoices that point at
 * it (invoices.journal_entry_id or an invoice_payments row): the
 * customer-side hänvisning (#2298). Kept apart from `counts` because a
 * register invoice is not a document row: the list must not offer a
 * paperclip with nothing behind it, but it must stop warning "Underlag
 * saknas" for an entry the verifikat page already lists an invoice on.
 *
 * Throws the first read error.
 */
export async function countUnderlagForJournalEntries(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: readonly string[],
): Promise<UnderlagCounts> {
  const out: UnderlagCounts = { counts: {}, invoice_references: {} }
  const chunks: string[][] = []
  for (let i = 0; i < journalEntryIds.length; i += UNDERLAG_COUNTS_CHUNK) {
    chunks.push(journalEntryIds.slice(i, i + UNDERLAG_COUNTS_CHUNK))
  }
  const results = await Promise.all(chunks.map((ids) => countChunk(supabase, companyId, ids)))
  for (const r of results) {
    Object.assign(out.counts, r.counts)
    Object.assign(out.invoice_references, r.invoice_references)
  }
  return out
}

async function countChunk(supabase: SupabaseClient, companyId: string, ids: string[]): Promise<UnderlagCounts> {
  const inList = `(${ids.join(',')})`
  const [directRes, siRes, sipRes] = await Promise.all([
    supabase
      .from('document_attachments')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .eq('is_current_version', true)
      .in('journal_entry_id', ids),
    supabase
      .from('supplier_invoices')
      .select(
        'document_id, registration_journal_entry_id, payment_journal_entry_id, document:document_attachments(journal_entry_id)',
      )
      .eq('company_id', companyId)
      .not('document_id', 'is', null)
      .or(
        `registration_journal_entry_id.in.${inList},payment_journal_entry_id.in.${inList}`,
      ),
    supabase
      .from('supplier_invoice_payments')
      .select(
        'journal_entry_id, supplier_invoice:supplier_invoices(document_id, document:document_attachments(journal_entry_id))',
      )
      .eq('company_id', companyId)
      .in('journal_entry_id', ids),
  ])

  if (directRes.error) throw directRes.error
  if (siRes.error) throw siRes.error
  if (sipRes.error) throw sipRes.error

  // Distinct doc ids per entry: a supplier invoice's document referenced from
  // both FK paths, or already directly linked, must not double count.
  const docsByEntry = new Map<string, Set<string>>()
  const add = (journalEntryId: string | null | undefined, documentId: string | null | undefined) => {
    if (!journalEntryId || !documentId) return
    let set = docsByEntry.get(journalEntryId)
    if (!set) {
      set = new Set<string>()
      docsByEntry.set(journalEntryId, set)
    }
    set.add(documentId)
  }

  for (const row of (directRes.data ?? []) as { id: string; journal_entry_id: string | null }[]) {
    add(row.journal_entry_id, row.id)
  }
  for (const row of (siRes.data ?? []) as unknown as {
    document_id: string | null
    registration_journal_entry_id: string | null
    payment_journal_entry_id: string | null
    document: { journal_entry_id: string | null } | null
  }[]) {
    if (!row.document?.journal_entry_id) continue // unanchored: not underlag
    add(row.registration_journal_entry_id, row.document_id)
    add(row.payment_journal_entry_id, row.document_id)
  }
  for (const row of (sipRes.data ?? []) as unknown as {
    journal_entry_id: string | null
    supplier_invoice: {
      document_id: string | null
      document: { journal_entry_id: string | null } | null
    } | null
  }[]) {
    if (!row.supplier_invoice?.document?.journal_entry_id) continue // unanchored
    add(row.journal_entry_id, row.supplier_invoice.document_id)
  }

  const invoiceRefs = await getInvoiceReferencesForJournalEntries(supabase, companyId, ids)

  // Referenced entries outside the requested set (an SI FK can point at an
  // entry the caller didn't ask about) must not leak into the response.
  const requested = new Set(ids)
  const counts: Record<string, number> = {}
  for (const [journalEntryId, docIds] of docsByEntry) {
    if (requested.has(journalEntryId)) counts[journalEntryId] = docIds.size
  }
  const invoice_references: Record<string, number> = {}
  for (const [journalEntryId, invoiceIds] of invoiceRefs) {
    if (requested.has(journalEntryId)) invoice_references[journalEntryId] = invoiceIds.length
  }
  return { counts, invoice_references }
}
