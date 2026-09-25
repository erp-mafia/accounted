import type { SupabaseClient } from '@supabase/supabase-js'
import { arkivSectionRollout, isArkivSectionEnabled } from '@/lib/arkiv/flag'

/**
 * Arkiv phase 7: the queue is decided by what the document is, not by the
 * door it came through. Once Arkiv has said what a document is, a receipt
 * or invoice that arrived any other way is queued in Underlag; an agreement,
 * registration, decision or minutes that arrived through the inbox leaves
 * the queue for its own page in Arkiv, and can come back if a person
 * retypes it. Nothing here books or deletes anything.
 *
 * A document leaves Underlag only for a page the company can open: the
 * shelf types documents for every company, but the Dokument section (where
 * a routed document is shown and retyped) is open only for the companies in
 * ARKIV_COMPANY_IDS. Outside it the document stays in Underlag, and the
 * sweep brings back what was routed before (requeueHiddenRoutedItems).
 */
export const VOUCHER_TYPES = new Set(['receipt', 'supplier_invoice', 'credit_note'])

/**
 * A queue item stays in Underlag, whatever Arkiv typed its document, when the inbox reader saw a bill in it:
 * a receipt or supplier invoice, or an amount on a government letter or on a document Arkiv could only call
 * "other". Where the two readers disagree, a person decides, and a person only sees Underlag. Prod 2026-09-25:
 * congestion-tax bills typed as Skatteverket decisions, credit notes typed "other" and supplier invoices typed
 * as customer invoices left the queue for a section their companies could not open.
 */
export function inboxSawABill(extracted: Record<string, unknown> | null | undefined, arkivType: string): boolean {
  if (!extracted) return false
  const kind = typeof extracted.documentKind === 'string' ? extracted.documentKind : null
  if (kind === 'receipt' || kind === 'supplier_invoice') return true
  const totals = extracted.totals as { total?: unknown } | null | undefined
  const total = typeof totals?.total === 'number' ? totals.total : Number(totals?.total ?? 0)
  if (!(Number.isFinite(total) && total > 0)) return false
  return kind === 'government_letter' || arkivType === 'other'
}

export type RouteOutcome = 'queued' | 'requeued' | 'already_queued' | 'booked' | 'routed_to_arkiv' | 'left' | 'not_found'

/**
 * Only a document classified within a day of arriving is put in the queue as new work. The Arkiv backfill
 * types documents uploaded long before, and queueing those handed 30 companies 152 to-dos nobody asked for
 * overnight (prod 2026-09-25, 85 of them one company's upload from eight days earlier). An old document
 * a person wants booked is booked from Arkiv, not pushed into their queue by a background job.
 */
export const QUEUE_NEW_WITHIN_MS = 24 * 60 * 60 * 1000

interface DocumentRow {
  id: string
  user_id: string | null
  created_at?: string | null
  journal_entry_id: string | null
  extracted_data: Record<string, unknown> | null
}

interface ItemRow {
  id: string
  extracted_data?: Record<string, unknown> | null
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
    .select('id, user_id, journal_entry_id, extracted_data, created_at')
    .eq('id', input.documentId)
    .eq('company_id', input.companyId)
    .maybeSingle()
  if (docError) throw new Error(`document fetch failed: ${docError.message}`)
  if (!doc) return 'not_found'
  const d = doc as DocumentRow
  const { data: rows, error: itemsError } = await supabase
    .from('invoice_inbox_items')
    .select('id, extracted_data, routed_to_arkiv_at, created_supplier_invoice_id, created_journal_entry_id, matched_transaction_id')
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
    if (d.created_at && Date.now() - new Date(d.created_at).getTime() > QUEUE_NEW_WITHIN_MS) return 'left'
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

  if (!isArkivSectionEnabled(input.companyId)) return 'left'
  const waiting = items.filter((i) => !consumed(i) && !i.routed_to_arkiv_at && !inboxSawABill(i.extracted_data ?? d.extracted_data, input.docType))
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
 * The sweep's catch-up: queue rows whose document Arkiv has since classified
 * as something not booked from here (a handler that was not wired, an event
 * lost in a deploy) leave the queue the same way the live route does, for
 * the companies that see the Dokument section and no others.
 */
export async function routeStaleQueueItems(supabase: SupabaseClient): Promise<number> {
  const section = arkivSectionRollout()
  if (section !== 'all' && section.length === 0) return 0
  let query = supabase
    .from('invoice_inbox_items')
    .select('id, document_id, extracted_data, document_attachments!inner(doc_type, admission_state)')
    .is('routed_to_arkiv_at', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .not('document_id', 'is', null)
  if (section !== 'all') query = query.in('company_id', section)
  const { data, error } = await query.limit(500)
  if (error) throw new Error(`stale queue select failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{
    id: string
    extracted_data?: Record<string, unknown> | null
    document_attachments: { doc_type: string | null; admission_state: string } | Array<{ doc_type: string | null; admission_state: string }>
  }>
  const byType = new Map<string, string[]>()
  for (const r of rows) {
    const doc = Array.isArray(r.document_attachments) ? r.document_attachments[0] : r.document_attachments
    if (!doc?.doc_type || doc.admission_state !== 'admitted' || VOUCHER_TYPES.has(doc.doc_type)) continue
    if (inboxSawABill(r.extracted_data, doc.doc_type)) continue
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

/**
 * The other half of the rule above: a routed row of a company that does not
 * see the Dokument section comes back to Underlag. It heals the rows routed
 * before the rule (every company since the shelf opened for all on
 * 2026-09-23) and a company taken off ARKIV_COMPANY_IDS later, so a routed
 * row always points at a page the company can open. Booked rows are cleared
 * too: they are shown among the booked ones instead of nowhere.
 */
export async function requeueHiddenRoutedItems(supabase: SupabaseClient): Promise<number> {
  const section = arkivSectionRollout()
  if (section === 'all') return 0
  // A bounded batch per pass, like the catch-up above: the sweep runs every two minutes and drains a backlog
  // (a large company taken off the list) in steps instead of one update that could time out and leave it all hidden.
  const hidden = supabase.from('invoice_inbox_items').select('id').not('routed_to_arkiv_at', 'is', null)
  const outside = section.length > 0 ? hidden.not('company_id', 'in', `(${section.map((id) => `"${id}"`).join(',')})`) : hidden
  const { data, error } = await outside.limit(500)
  if (error) throw new Error(`routed item requeue select failed: ${error.message}`)
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (ids.length === 0) return 0
  const { error: updateError } = await supabase.from('invoice_inbox_items').update({ routed_to_arkiv_at: null, routed_doc_type: null }).in('id', ids)
  if (updateError) throw new Error(`routed item requeue failed: ${updateError.message}`)
  return ids.length
}
