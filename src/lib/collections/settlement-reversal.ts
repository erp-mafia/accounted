import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('collections/settlement-reversal')

/** The reason a payout waits for a person again after its voucher was reversed. */
export const SETTLEMENT_VOUCHER_REVERSED = 'voucher_reversed'

/**
 * A payout voucher (source_type collection_settlement) reversed through the
 * storno path: the payout goes back to the settlements view for a person to
 * book again. The storno puts the collected capital back on the clearing
 * account, so the collected payments the payout settled are untied from it,
 * its lines are unbooked, and the booked mark is cleared so the next voucher
 * is told to the provider. The archived settlement PDF stays the underlag of
 * the reversed voucher; the next booking archives a fresh copy for its own
 * voucher (a document is the underlag of one voucher).
 *
 * Collections rows are written by the service role only (members read them
 * through RLS), so this runs on a service client whatever client reversed
 * the voucher. Like the other business-state mirrors after a reversal it
 * never undoes the storno: a failure is logged and the payout keeps pointing
 * at the reversed voucher until it is run again.
 */
export async function releaseSettlementAfterReversal(
  companyId: string,
  entryId: string,
  deps: { db?: SupabaseClient } = {},
): Promise<{ released: boolean }> {
  try {
    const db = deps.db ?? (await import('@/lib/supabase/server')).createServiceClient()
    const { data, error } = await db
      .from('collection_settlements')
      .select('id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', entryId)
      .maybeSingle()
    if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
    const settlementId = (data as { id: string } | null)?.id
    if (!settlementId) return { released: false }

    const { error: paymentsError } = await db
      .from('collection_collected_payments')
      .update({ settlement_id: null })
      .eq('company_id', companyId)
      .eq('settlement_id', settlementId)
    if (paymentsError) throw new Error(`collection_collected_payments update failed: ${paymentsError.message}`)

    const { error: linesError } = await db
      .from('collection_settlement_lines')
      .update({ booked: false })
      .eq('company_id', companyId)
      .eq('settlement_id', settlementId)
    if (linesError) throw new Error(`collection_settlement_lines update failed: ${linesError.message}`)

    const { error: settlementError } = await db
      .from('collection_settlements')
      .update({
        status: 'needs_mapping',
        needs_mapping_reason: SETTLEMENT_VOUCHER_REVERSED,
        journal_entry_id: null,
        booked_at: null,
        booked_by: null,
        document_attachment_id: null,
        provider_acknowledged_at: null,
        booking_lease_until: null,
        // The storno released the bank row from the voucher; the next booking links it again.
        bank_transaction_id: null,
      })
      .eq('company_id', companyId)
      .eq('id', settlementId)
      .eq('journal_entry_id', entryId)
    if (settlementError) throw new Error(`collection_settlements update failed: ${settlementError.message}`)
    log.info('payout returned to the settlements view after its voucher was reversed', { settlementId, entryId })
    return { released: true }
  } catch (err) {
    log.error('failed to release the payout of a reversed payout voucher', err instanceof Error ? err : new Error(String(err)), {
      companyId,
      entryId,
    })
    return { released: false }
  }
}
