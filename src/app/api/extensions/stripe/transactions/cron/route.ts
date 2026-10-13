import { withCronContext } from '@/lib/api/with-cron-context'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { extensionRegistry } from '@/lib/extensions/registry'
import { extensionDisabledSkip, runWebshopOrderCron } from '@/lib/webshop-orders/order-cron'
import { syncStripeBalanceTransactions } from '@/extensions/general/stripe/lib/transaction-sync'
import type { StripeConnection } from '@/extensions/general/stripe/types'

export const maxDuration = 300

/**
 * GET /api/extensions/stripe/transactions/cron
 * Nightly balance-transaction sync for connections that opted in
 * (transaction_sync_enabled): imports the connected Stripe balance into the
 * transactions inbox as a bank-style feed on the 1686 cash account. The run
 * is runWebshopOrderCron, ordered by last_balance_txn_synced_at, so a front
 * of non-entitled or quiet connections no longer starves the rest.
 *
 * Read-only against Stripe, and it never posts to the journal: rows land
 * unbooked; booking stays a human decision. Idempotent via the
 * (company_id, external_id) unique index, so overlapping windows and re-runs
 * are no-ops. A connection Stripe reports as revoked is marked revoked here.
 */
export const GET = withCronContext('cron.stripe_transaction_sync', async (_request, ctx) => {
  if (!(await extensionRegistry.get('stripe'))) return extensionDisabledSkip(ctx, 'stripe')
  return runWebshopOrderCron<StripeConnection>(ctx, {
    extensionId: 'stripe',
    label: 'Stripe Connect',
    table: 'stripe_connections',
    cursorColumn: 'last_balance_txn_synced_at',
    capability: CAPABILITY.stripe_payments,
    isConfigured: () => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT_CLIENT_ID),
    // The runner counts inserted rows; a feed row is imported, never updated.
    sync: async (supabase, connection, log, deadlineMs) => {
      const summary = await syncStripeBalanceTransactions(supabase, connection, log, deadlineMs)
      return { inserted: summary.imported, updated: 0, deadlineReached: summary.deadlineReached, revoked: summary.revoked }
    },
  })
})
