/**
 * A payment the bank holds for another signatory (awaiting_second_signer)
 * and where that signature is given. The bank says it with the status, and
 * the provider adapter reads it (ProviderPaymentState.secondSignatureViaApi):
 * at SEB the first BankID leaves the payments waiting within seconds, and the
 * other signatory signs the same basket or payment through a new
 * authorisation under their own PSU-ID (startSecondSignature in signing.ts).
 * Otherwise the signature is given in the bank's online bank, as before.
 *
 * The answer is kept on the order's record: applyProviderState writes it
 * with the move to awaiting_second_signer, which happens once per order.
 * Every reader (the list, the signing's view, the link and its page, the
 * start itself) applies the one rule below.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The orders, of those given, whose move to awaiting_second_signer recorded that the bank takes the second signature through the API. */
export async function secondSignatureViaApi(reader: SupabaseClient, companyId: string, orderIds: readonly string[]): Promise<Set<string>> {
  const viaApi = new Set<string>()
  if (orderIds.length === 0) return viaApi
  const { data, error } = await reader
    .from('payment_order_events')
    .select('payment_order_id, detail')
    .eq('company_id', companyId)
    .eq('event_type', 'status_changed')
    .eq('to_status', 'awaiting_second_signer')
    .in('payment_order_id', [...orderIds])
  if (error) throw error
  for (const row of (data ?? []) as Array<{ payment_order_id: string | null; detail: { second_signature_via_api?: unknown } | null }>) {
    if (row.payment_order_id && row.detail?.second_signature_via_api === true) viaApi.add(row.payment_order_id)
  }
  return viaApi
}

/**
 * The rule: the second signature of a signing is given here when the bank
 * said the API for every payment of it that waits. It signs the whole basket
 * at once, so one answer covers them all.
 */
export function secondSignatureHere(waiting: readonly string[], viaApi: ReadonlySet<string>): boolean {
  return waiting.length > 0 && waiting.every((id) => viaApi.has(id))
}
