import type { SupabaseClient } from '@supabase/supabase-js'
import type { WebshopPayout } from '@/types'

/**
 * What a provider's payout source hands the store (webshop_payouts): Kustom's
 * settlement report (kustom-settlement.ts), Shopify Payments' payouts (the
 * Shopify extension's payout sync). The parts are signed toward the payout
 * and add up to `amount` (payouts.ts).
 */
export type WebshopPayoutRecord = Pick<
  WebshopPayout,
  'platform' | 'store_scope' | 'external_id' | 'reference' | 'payout_date' | 'currency' | 'amount' | 'lines'
>

/**
 * Store payouts once each: a payout already stored is found by its provider
 * key. One no bank row has claimed takes the source's figures again (a
 * corrected report, a payout that settled after it was first read); a claimed
 * or booked one keeps what it was booked by. Service role: payout rows have no
 * member write policy. Throws on a failed write, naming it.
 */
export async function storeWebshopPayouts(
  service: SupabaseClient,
  companyId: string,
  userId: string | null,
  records: readonly WebshopPayoutRecord[],
): Promise<void> {
  for (const record of records) {
    const { error: insertError } = await service
      .from('webshop_payouts')
      .upsert({ ...record, company_id: companyId, user_id: userId }, { onConflict: 'company_id,external_id', ignoreDuplicates: true })
    if (insertError) throw new Error(`payout ${record.external_id} not stored: ${insertError.message}`)
    const { error: refreshError } = await service
      .from('webshop_payouts')
      .update({
        reference: record.reference,
        payout_date: record.payout_date,
        currency: record.currency,
        amount: record.amount,
        lines: record.lines,
      })
      .eq('company_id', companyId)
      .eq('external_id', record.external_id)
      .is('transaction_id', null)
      .is('journal_entry_id', null)
    if (refreshError) throw new Error(`payout ${record.external_id} not refreshed: ${refreshError.message}`)
  }
}
