/**
 * Business-state mirror of a reversed rot_rut_reclaim voucher.
 *
 * The reclaim (lib/invoices/rot-rut-reclaim.ts) moves Skatteverkets refused
 * share from 1513 onto the customer (1510) and reopens the invoices for it.
 * When that voucher is reversed (booked on the wrong date, or Skatteverket
 * granted the share on omprövning), the GL is restored by the storno but the
 * invoice rows and the begäran would still say "reclaimed": the invoice open
 * for a share nobody owes, the begäran unreclaimable forever
 * (ROT_RUT_RECLAIM_ALREADY_DONE), the file blocker DEDUCTION_RECLAIMED stuck.
 * Called from reverseEntry() next to the payment sync, and kept in its own
 * module so the engine can import it without a cycle (the reclaim service
 * imports the entries builder, which imports the engine).
 *
 * Every leg is one atomic, idempotent RPC (revert_rot_rut_reclaim_invoice):
 * the item marker (reclaimed_amount) is the amount handed back and is
 * cleared in the same transaction as the invoice row, so a re-run after a
 * failure reverts only the legs still carrying a marker. The request's
 * reclaim_journal_entry_id is cleared LAST and only when every leg
 * succeeded, so a later run can still find the begäran by the reversed
 * voucher and finish the job.
 *
 * A customer payment that already covered the reclaimed share is NOT undone
 * (that voucher stands): the invoice then reads paid with an over-collected
 * 1510, which is the honest state of the ledger after that sequence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/rot-rut-reclaim-reversal')

interface ReclaimedItemRow {
  id: string
  invoice_id: string
  reclaimed_amount: number | string | null
}

export async function syncRotRutReclaimAfterReversal(
  supabase: SupabaseClient,
  companyId: string,
  reclaimJournalEntryId: string,
): Promise<void> {
  const { data: request, error: requestError } = await supabase
    .from('rot_rut_payout_requests')
    .select('id')
    .eq('company_id', companyId)
    .eq('reclaim_journal_entry_id', reclaimJournalEntryId)
    .maybeSingle()
  if (requestError) {
    log.error('reclaim reversal: failed to find the begäran', requestError as Error, {
      reclaimJournalEntryId,
    })
    return
  }
  if (!request) return

  const { data: itemRows, error: itemsError } = await supabase
    .from('rot_rut_payout_request_items')
    .select('id, invoice_id, reclaimed_amount')
    .eq('request_id', request.id)
  if (itemsError) {
    log.error('reclaim reversal: failed to load items', itemsError as Error, {
      payoutRequestId: request.id,
    })
    return
  }

  for (const item of (itemRows ?? []) as ReclaimedItemRow[]) {
    if (item.reclaimed_amount == null) continue
    const { error: revertError } = await supabase.rpc('revert_rot_rut_reclaim_invoice', {
      p_item_id: item.id,
      p_invoice_id: item.invoice_id,
      p_company_id: companyId,
    })
    if (revertError) {
      // Keep the request link: the next reversal sync (or a support re-run)
      // finds the begäran by the reversed voucher and completes this leg.
      log.error('reclaim reversal: invoice leg failed, request link kept for retry', revertError as Error, {
        invoiceId: item.invoice_id,
        itemId: item.id,
        payoutRequestId: request.id,
        reclaimJournalEntryId,
      })
      return
    }
  }

  const { error: requestUpdateError } = await supabase
    .from('rot_rut_payout_requests')
    .update({ reclaim_journal_entry_id: null, reclaimed_at: null })
    .eq('company_id', companyId)
    .eq('id', request.id)
    .eq('reclaim_journal_entry_id', reclaimJournalEntryId)
  if (requestUpdateError) {
    log.error('reclaim reversal: request reset failed', requestUpdateError as Error, {
      payoutRequestId: request.id,
    })
    return
  }

  log.info('rot/rut reclaim reversed: invoices closed again', {
    payoutRequestId: request.id,
    reclaimJournalEntryId,
  })
}
