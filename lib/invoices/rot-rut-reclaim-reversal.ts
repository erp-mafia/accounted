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
 * Per invoice: deduction_reclaimed_total shrinks by the item's reclaimed
 * amount, remaining_amount is re-derived through the one customer-share
 * definition, and the status follows the money: nothing outstanding and
 * something paid means paid again, otherwise partially_paid / sent / overdue.
 * A customer payment that already covered the reclaimed share is NOT undone
 * (that voucher stands): the invoice then reads paid with an over-collected
 * 1510, which is the honest state of the ledger after that sequence.
 *
 * Best-effort with loud logging, like the payment sync: the storno voucher
 * is already posted and immutable when this runs.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { invoiceCustomerOutstanding } from '@/lib/invoices/customer-share'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/rot-rut-reclaim-reversal')

interface ReclaimedItemRow {
  id: string
  invoice_id: string
  reclaimed_amount: number | string | null
}

interface InvoiceRow {
  id: string
  status: string
  total: number | string
  paid_amount: number | string | null
  due_date: string | null
  deduction_total: number | string | null
  deduction_reclaimed_total: number | string | null
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
    const reclaimed = roundOre(Number(item.reclaimed_amount ?? 0))
    if (!(reclaimed > 0)) continue

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('id, status, total, paid_amount, due_date, deduction_total, deduction_reclaimed_total')
      .eq('id', item.invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (invoiceError || !invoice) {
      log.error('reclaim reversal: invoice not readable', invoiceError ?? undefined, {
        invoiceId: item.invoice_id,
      })
      continue
    }
    const row = invoice as InvoiceRow
    const newReclaimed = Math.max(0, roundOre(Number(row.deduction_reclaimed_total ?? 0) - reclaimed))
    const paid = roundOre(Number(row.paid_amount ?? 0))
    const outstanding = invoiceCustomerOutstanding(
      {
        total: Number(row.total),
        deduction_total: Number(row.deduction_total ?? 0),
        deduction_reclaimed_total: newReclaimed,
      },
      paid,
    )
    const newRemaining = Math.max(0, outstanding)
    let newStatus = row.status
    if (['sent', 'overdue', 'partially_paid', 'paid'].includes(row.status)) {
      if (newRemaining <= 0 && paid > 0) newStatus = 'paid'
      else if (paid > 0) newStatus = 'partially_paid'
      else if (row.due_date && new Date(row.due_date) < new Date()) newStatus = 'overdue'
      else newStatus = 'sent'
    }

    const { error: updateError } = await supabase
      .from('invoices')
      .update({
        deduction_reclaimed_total: newReclaimed,
        remaining_amount: newRemaining,
        status: newStatus,
      })
      .eq('id', row.id)
      .eq('company_id', companyId)
    if (updateError) {
      log.error('reclaim reversal: invoice update failed', updateError as Error, {
        invoiceId: row.id,
        reclaimJournalEntryId,
      })
      continue
    }

    const { error: itemError } = await supabase
      .from('rot_rut_payout_request_items')
      .update({ reclaimed_amount: null })
      .eq('id', item.id)
    if (itemError) {
      log.warn('reclaim reversal: item reset failed', { itemId: item.id, message: itemError.message })
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
