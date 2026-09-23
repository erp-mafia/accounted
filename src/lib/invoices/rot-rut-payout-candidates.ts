import type { SupabaseClient } from '@supabase/supabase-js'
import {
  OPEN_ROT_RUT_PAYOUT_STATUSES,
  type RotRutPayoutRequestCandidate,
} from './rot-rut-payout-matching'

/**
 * Open, unsettled ROT/RUT begäran for a company: the candidate pool for
 * matching Skatteverkets utbetalning against a bank row.
 *
 * Own module so import-time callers (bank ingest, the batch re-suggest route)
 * can be unit-tested with the pool mocked, the same way getBestInvoiceMatch
 * is. Non-fatal: any error yields an empty pool and matching is skipped.
 */
export async function loadOpenRotRutPayoutRequests(
  supabase: SupabaseClient,
  companyId: string,
): Promise<RotRutPayoutRequestCandidate[]> {
  try {
    const { data, error } = await supabase
      .from('rot_rut_payout_requests')
      .select('id, name, deduction_type, status, requested_total, decided_total, settlement_journal_entry_id')
      .eq('company_id', companyId)
      .in('status', [...OPEN_ROT_RUT_PAYOUT_STATUSES])
      .is('settlement_journal_entry_id', null)
    if (error) return []
    return (data ?? []) as RotRutPayoutRequestCandidate[]
  } catch {
    return []
  }
}
