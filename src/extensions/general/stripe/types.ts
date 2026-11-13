/**
 * How far back an explicit backfill (POST /backfill) may reach. Our own floor,
 * same as Zettle's: far enough to cover the years anyone still books, short
 * enough that a mistyped year cannot ask for an unbounded scan (the balance
 * transaction list has no history limit of its own). The company lock date
 * still floors the window inside the sync. Lives here so the client panel
 * can bound its date picker without importing the server-side sync module.
 */
export const MAX_BACKFILL_YEARS = 3

/** Row shape of public.stripe_connections. */
export interface StripeConnection {
  id: string
  company_id: string
  user_id: string
  stripe_account_id: string | null
  livemode: boolean
  status: 'pending' | 'active' | 'revoked' | 'error'
  oauth_state: string | null
  display_name: string | null
  last_event_created_at: string | null
  last_event_id: string | null
  /** Opt-in: import the account's balance transactions as an inbox feed. */
  transaction_sync_enabled: boolean
  /** Balance-transaction polling cursor (max `created` processed). */
  last_balance_txn_synced_at: string | null
  /**
   * The feed start (a connection moment or backfill day) whose open Stripe
   * balance the feed has read; null means connected_at. A cursor at or before
   * it starts a first run (transaction-sync planFetch). Optional: absent until
   * migration 20261113002101 has run.
   */
  balance_txn_feed_start?: string | null
  error_message: string | null
  connected_at: string | null
  disconnected_at: string | null
  created_at: string
  updated_at: string
}

/** Status payload returned by GET /api/extensions/ext/stripe/status. */
export interface StripeStatusResponse {
  configured: boolean
  connection: Pick<
    StripeConnection,
    | 'id'
    | 'status'
    | 'stripe_account_id'
    | 'livemode'
    | 'display_name'
    | 'error_message'
    | 'connected_at'
    | 'last_event_created_at'
    | 'transaction_sync_enabled'
    | 'last_balance_txn_synced_at'
  > | null
}
