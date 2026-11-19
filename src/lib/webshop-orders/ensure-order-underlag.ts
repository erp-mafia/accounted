import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { loadWebshopOrder } from '@/lib/webshop-orders/book-order'
import {
  archiveWebshopOrderUnderlag,
  ORDER_UNDERLAG_FILENAME_PREFIX,
} from '@/lib/webshop-orders/order-underlag'

export type EnsureOrderUnderlagOutcome =
  /** The verifikat carries its orderunderlag: found (alreadyAttached) or archived now. */
  | { ok: true; alreadyAttached: boolean; journalEntryId: string; documentId: string }
  | { ok: false; kind: 'not_found' }
  /** No verifikat to attach to: the order is not booked through the integration. */
  | { ok: false; kind: 'not_booked' }
  /** The lookup or the archive failed; nothing was attached. */
  | { ok: false; kind: 'failed'; journalEntryId: string }

/**
 * Give a booked order's verifikat its orderunderlag when it has none.
 *
 * Booking archives the underlag right after commit but never fails on it
 * (archiveWebshopOrderUnderlag), so a verifikat can end up without one. This
 * is the retry: it looks for the system-generated orderunderlag on the
 * order's verifikat and archives one only when it is missing, so repeating
 * the call never files a second copy. It adds a document and touches nothing
 * else on the posted entry.
 */
export async function ensureWebshopOrderUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  orderId: string,
  log: Logger,
): Promise<EnsureOrderUnderlagOutcome> {
  const order = await loadWebshopOrder(supabase, companyId, orderId)
  if (!order) return { ok: false, kind: 'not_found' }
  const journalEntryId = order.journal_entry_id
  if (!journalEntryId) return { ok: false, kind: 'not_booked' }

  const { data: existing, error: lookupError } = await supabase
    .from('document_attachments')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .eq('upload_source', 'system')
    .eq('is_current_version', true)
    .ilike('file_name', `${ORDER_UNDERLAG_FILENAME_PREFIX}%`)
    .limit(1)
  if (lookupError) {
    // Fail closed: archiving on a broken lookup could file a duplicate.
    log.error('order underlag lookup failed', lookupError, { orderId, journalEntryId })
    return { ok: false, kind: 'failed', journalEntryId }
  }
  const found = (existing as Array<{ id: string }> | null)?.[0]
  if (found) {
    return { ok: true, alreadyAttached: true, journalEntryId, documentId: found.id }
  }

  const archived = await archiveWebshopOrderUnderlag({
    supabase,
    companyId,
    userId,
    order,
    journalEntryId,
    log,
  })
  if (!archived.ok || !archived.documentId) {
    return { ok: false, kind: 'failed', journalEntryId }
  }
  return { ok: true, alreadyAttached: false, journalEntryId, documentId: archived.documentId }
}
