import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import type { Logger } from '@/lib/logger'
import type { StripeConnection } from '../types'

/**
 * The connected account severed access on Stripe's side (see
 * isRevokedConnectionError): mark the connection revoked and land the
 * transition in the audit trail.
 *
 * Every sync that talks to Stripe calls this on a revocation error, so the
 * settings panel stops showing a dead connection as connected and the nightly
 * cron stops polling it. An upstream revocation is the same outward-facing
 * consent transition as a user-initiated disconnect, so it emits the same
 * stripe.disconnected event with reason 'revoked_upstream'.
 */
export async function markConnectionRevokedUpstream(
  supabase: SupabaseClient,
  connection: StripeConnection,
  log: Logger,
): Promise<void> {
  log.warn('connection revoked upstream; marking revoked', {
    connectionId: connection.id,
  })
  await supabase
    .from('stripe_connections')
    .update({
      status: 'revoked',
      disconnected_at: new Date().toISOString(),
      error_message: 'Åtkomsten återkallades hos Stripe.',
    })
    .eq('id', connection.id)
  try {
    await eventBus.emit({
      type: 'stripe.disconnected',
      payload: {
        connectionId: connection.id,
        stripeAccountId: connection.stripe_account_id,
        reason: 'revoked_upstream',
        userId: connection.user_id,
        companyId: connection.company_id,
      },
    })
  } catch {
    // Audit event failure must not block marking the connection revoked.
  }
}
