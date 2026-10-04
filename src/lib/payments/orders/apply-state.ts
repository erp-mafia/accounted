/**
 * Apply what the bank reports about one payment to its order, forward only.
 *
 * A provider may report an earlier status than the one the order already has
 * (a pending code after acceptance, a basket status that lags its payments).
 * Such a report updates provider_status for the record but never moves the
 * order backwards: the move must be one the lifecycle allows
 * (canMovePaymentOrder, the same list the database trigger enforces).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderPaymentState } from '@/lib/payments/initiation/provider'
import { canMovePaymentOrder, type PaymentOrderStatus } from './status'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'

export async function applyProviderState(
  writer: SupabaseClient,
  order: Pick<PaymentOrderRow, 'id' | 'company_id' | 'status'>,
  state: ProviderPaymentState,
  actorUserId: string | null,
): Promise<PaymentOrderStatus> {
  const now = new Date().toISOString()
  // 'submitted' from the bank only means "received, nothing happened yet". It
  // is never applied as a move: after a finalised signing the bank can still
  // answer RCVD for a moment, and awaiting_signature -> submitted is reserved
  // for our own "signing abandoned, sign again" path.
  const moves =
    state.status !== order.status && state.status !== 'submitted' && canMovePaymentOrder(order.status, state.status)
  const next: PaymentOrderStatus = moves ? state.status : order.status
  const { data, error } = await writer
    .from('payment_orders')
    .update({
      provider_status: state.providerStatus || null,
      provider_status_at: now,
      // Undefined keys are left out of the request, so a report that does not
      // move the order writes only the provider columns.
      status: moves ? next : undefined,
      signed_at: moves && (next === 'accepted' || next === 'awaiting_second_signer') ? now : undefined,
      executed_at: moves && next === 'executed' ? now : undefined,
    })
    .eq('id', order.id)
    .eq('company_id', order.company_id)
    // Compare-and-set on the status we read: a concurrent writer wins, we re-read next time.
    .eq('status', order.status)
    .select('id')
  if (error) throw error
  if (moves && (data ?? []).length === 1) {
    await logPaymentOrderEvents(writer, [
      {
        company_id: order.company_id,
        payment_order_id: order.id,
        event_type: 'status_changed',
        from_status: order.status,
        to_status: next,
        provider_status: state.providerStatus,
        actor_user_id: actorUserId,
        detail: state.messages.length ? { messages: state.messages } : {},
      },
    ])
    return next
  }
  return order.status
}
