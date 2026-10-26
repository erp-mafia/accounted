import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A document's reading, carried onto the Underlag item filed for it before
 * the reading landed.
 *
 * A document that comes in any door but the inbox's own (Dokument, a
 * mailbox, the partner API) has two readers of document.uploaded running
 * side by side: the classifier, which queues a receipt or invoice in
 * Underlag (route-from-arkiv in the inbox extension), and the
 * document-extraction reader, which writes the reading onto the document
 * row. The classifier is a cheap call on the page text and usually wins, so
 * the item was filed unread and stayed that way: prod 2026-10-26, 29 open
 * items in 15 companies with AI reading, each queued seconds before its
 * reading landed, none with a supplier match. Whichever finishes second
 * fills the item: the queue copies a reading that is already there, and
 * this runs once the reading is there (from the reader, and from the
 * queue's own look after filing).
 *
 * Only an item nobody has touched: received, still without a reading (a
 * person's fields and a retry's reading are never overwritten), and not
 * booked, registered or linked. A document Arkiv typed as a credit note
 * keeps saying so, as the queue's own copy does (issue #2980). The supplier
 * card is looked up only when a filled item has none, and written only where
 * none was picked. Returns the ids it filled.
 */
export async function carryReadingToQueuedItems(
  supabase: SupabaseClient,
  input: { companyId: string; documentId: string; reading: Record<string, unknown> },
  options: { supplierFor?: () => Promise<string | null> } = {},
): Promise<string[]> {
  const { data: waiting, error: waitingError } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', input.companyId)
    .eq('document_id', input.documentId)
    .eq('status', 'received')
    .is('extracted_data', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
  if (waitingError) throw new Error(`queued item select failed: ${waitingError.message}`)
  const ids = ((waiting as Array<{ id: string }> | null) ?? []).map((row) => row.id)
  if (ids.length === 0) return []

  const { data: doc } = await supabase.from('document_attachments').select('doc_type').eq('id', input.documentId).eq('company_id', input.companyId).maybeSingle()
  const reading = (doc as { doc_type?: string | null } | null)?.doc_type === 'credit_note' ? { ...input.reading, documentKind: 'credit_note' } : input.reading

  const { data: filled, error } = await supabase
    .from('invoice_inbox_items')
    .update({ extracted_data: reading, extraction_skipped: false })
    .in('id', ids)
    .eq('company_id', input.companyId)
    .eq('status', 'received')
    .is('extracted_data', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .select('id, matched_supplier_id')
  if (error) throw new Error(`queued item fill failed: ${error.message}`)
  const rows = (filled as Array<{ id: string; matched_supplier_id: string | null }> | null) ?? []

  const withoutSupplier = rows.filter((row) => !row.matched_supplier_id).map((row) => row.id)
  if (withoutSupplier.length > 0 && options.supplierFor) {
    const supplierId = await options.supplierFor()
    if (supplierId) {
      const { error: supplierError } = await supabase
        .from('invoice_inbox_items')
        .update({ matched_supplier_id: supplierId })
        .in('id', withoutSupplier)
        .eq('company_id', input.companyId)
        .is('matched_supplier_id', null)
      if (supplierError) throw new Error(`queued item supplier match failed: ${supplierError.message}`)
    }
  }
  return rows.map((row) => row.id)
}
