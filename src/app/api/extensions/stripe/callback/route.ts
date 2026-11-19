import { completePartnerOAuthCallback } from '@/lib/auth/partner-oauth-callback'
import {
  exchangeCodeForAccount,
  fetchAccountDisplayName,
} from '@/extensions/general/stripe/lib/connect'

/**
 * GET /api/extensions/stripe/callback
 *
 * OAuth callback for Stripe Connect authorization. Must be a real Next.js
 * route (not an extension dispatcher handler) because Stripe redirects the
 * user's browser to this URL directly. The flow itself (state lookup,
 * initiator binding, code replay guard, compare-and-set activation) is the
 * shared partner callback.
 */
export function GET(request: Request) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return completePartnerOAuthCallback(request, {
    extensionId: 'stripe',
    displayName: 'Stripe',
    provider: 'stripe',
    table: 'stripe_connections',
    pendingColumns: 'id, user_id, company_id',
    // The Stripe surface lives on the import page (?mode=stripe opens the
    // panel directly); the shared flow appends its params with '&'.
    returnUrl: async () => `${baseUrl}/import?mode=stripe`,
    async exchange(code) {
      const { stripeAccountId, livemode } = await exchangeCodeForAccount(code)
      const displayName = await fetchAccountDisplayName(stripeAccountId)
      // Seed the balance-transaction cursor with the connection moment. The
      // first sync adds only what was still on the Stripe balance then (money
      // Stripe already paid out is booked from the bank side, #2631), or
      // starts at the connection day when 1686 already carries the balance
      // (crm#1344, planFetch in transaction-sync). Reaching further back is an
      // explicit choice: POST /api/extensions/ext/stripe/backfill with a date.
      const connectedAt = new Date().toISOString()
      return {
        stripe_account_id: stripeAccountId,
        livemode,
        display_name: displayName,
        connected_at: connectedAt,
        last_balance_txn_synced_at: connectedAt,
        // Feed-only product: connecting Stripe means fetching its
        // transactions, so the nightly feed starts on by default. The panel
        // toggle remains as the opt-out.
        transaction_sync_enabled: true,
      }
    },
    activatedColumns: 'id, company_id, user_id, stripe_account_id, livemode',
    conflictMessage: 'Stripe-kontot är redan anslutet till ett företag.',
    connectedEvent: (row) => ({
      type: 'stripe.connected',
      payload: {
        connectionId: row.id as string,
        stripeAccountId: row.stripe_account_id as string,
        livemode: row.livemode as boolean,
        userId: row.user_id as string,
        companyId: row.company_id as string,
      },
    }),
  })
}
