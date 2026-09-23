import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Arkiv phase 7: the queue is decided by what the document is, not by the
 * door it came through. Once Arkiv has said what a document is, a receipt
 * or invoice that arrived any other way is queued in Underlag; an agreement,
 * registration, decision or minutes that arrived through the inbox leaves
 * the queue for its own page in Arkiv, and can come back if a person
 * retypes it. Nothing here books or deletes anything.
 */
export const VOUCHER_TYPES = new Set(['receipt', 'supplier_invoice', 'credit_note'])

export type RouteOutcome = 'queued' | 'requeued' | 'already_queued' | 'booked' | 'routed_to_arkiv' | 'left' | 'not_found'

interface DocumentRow {
  id: string
  user_id: string | null
  journal_entry_id: string | null
  extracted_data: Record<string, unknown> | null
}

interface ItemRow {
  id: string
  routed_to_arkiv_at: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  matched_transaction_id: string | null
}

const consumed = (i: ItemRow) => !!(i.created_supplier_invoice_id || i.created_journal_entry_id || i.matched_transaction_id)

export async function routeClassifiedDocument(
  supabase: SupabaseClient,
  input: { documentId: string; companyId: string; userId: string | null; docType: string; admission: 'admitted' | 'held' },
): Promise<RouteOutcome> {
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, user_id, journal_entry_id, extracted_data')
    .eq('id', input.documentId)
    .eq('company_id', input.companyId)
    .maybeSingle()
  if (docError) throw new Error(`document fetch failed: ${docError.message}`)
  if (!doc) return 'not_found'
  const d = doc as DocumentRow
  const { data: rows, error: itemsError } = await supabase
    .from('invoice_inbox_items')
    .select('id, routed_to_arkiv_at, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id')
    .eq('company_id', input.companyId)
    .eq('document_id', input.documentId)
  if (itemsError) throw new Error(`inbox items fetch failed: ${itemsError.message}`)
  const items = (rows ?? []) as ItemRow[]
  const now = new Date().toISOString()

  if (VOUCHER_TYPES.has(input.docType) && input.admission === 'admitted') {
    if (d.journal_entry_id || items.some(consumed)) return 'booked'
    const open = items.find((i) => !consumed(i))
    if (open?.routed_to_arkiv_at) {
      const { error } = await supabase.from('invoice_inbox_items').update({ routed_to_arkiv_at: null, routed_doc_type: null }).eq('id', open.id)
      if (error) throw new Error(`inbox item update failed: ${error.message}`)
      return 'requeued'
    }
    if (open) return 'already_queued'
    const { error } = await supabase.from('invoice_inbox_items').insert({
      company_id: input.companyId,
      user_id: input.userId || d.user_id,
      status: 'received',
      source: 'upload',
      document_id: input.documentId,
      kind_hint: input.docType === 'receipt' ? 'receipt' : 'supplier_invoice',
      extracted_data: d.extracted_data ?? null,
      extraction_skipped: d.extracted_data == null,
    })
    if (error) throw new Error(`inbox item insert failed: ${error.message}`)
    return 'queued'
  }

  const waiting = items.filter((i) => !consumed(i) && !i.routed_to_arkiv_at)
  if (waiting.length === 0) return 'left'
  const { error } = await supabase
    .from('invoice_inbox_items')
    .update({ routed_to_arkiv_at: now, routed_doc_type: input.docType })
    .in(
      'id',
      waiting.map((i) => i.id),
    )
  if (error) throw new Error(`inbox item update failed: ${error.message}`)
  return 'routed_to_arkiv'
}

/**
 * The nightly catch-up: queue rows whose document Arkiv has since classified
 * as something not booked from here (a handler that was not wired, an event
 * lost in a deploy) leave the queue the same way the live route does.
 */
export async function routeStaleQueueItems(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, document_attachments!inner(doc_type, admission_state)')
    .is('routed_to_arkiv_at', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .not('document_id', 'is', null)
    .limit(500)
  if (error) throw new Error(`stale queue select failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{
    id: string
    document_attachments: { doc_type: string | null; admission_state: string } | Array<{ doc_type: string | null; admission_state: string }>
  }>
  const byType = new Map<string, string[]>()
  for (const r of rows) {
    const doc = Array.isArray(r.document_attachments) ? r.document_attachments[0] : r.document_attachments
    if (!doc?.doc_type || doc.admission_state !== 'admitted' || VOUCHER_TYPES.has(doc.doc_type)) continue
    byType.set(doc.doc_type, [...(byType.get(doc.doc_type) ?? []), r.id])
  }
  let routed = 0
  const now = new Date().toISOString()
  for (const [docType, ids] of byType) {
    const { error: updateError } = await supabase.from('invoice_inbox_items').update({ routed_to_arkiv_at: now, routed_doc_type: docType }).in('id', ids)
    if (updateError) throw new Error(`stale queue update failed: ${updateError.message}`)
    routed += ids.length
  }
  return routed
}
