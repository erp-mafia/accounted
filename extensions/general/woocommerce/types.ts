/** Row shape of public.woocommerce_connections. */
export interface WooCommerceConnection {
  id: string
  company_id: string
  user_id: string
  /** Normalized https origin (+ optional subdirectory path), no trailing slash. */
  store_url: string
  store_name: string | null
  consumer_key_encrypted: string | null
  consumer_secret_encrypted: string | null
  key_permissions: string | null
  status: 'pending' | 'active' | 'revoked' | 'error'
  oauth_state: string | null
  currency: string | null
  prices_include_tax: boolean | null
  wc_version: string | null
  /** Opt-in: nightly order-feed cron (the manual sync button ignores it). */
  transaction_sync_enabled: boolean
  /** Order-polling cursor (max date_modified_gmt processed). */
  last_order_synced_at: string | null
  error_message: string | null
  connected_at: string | null
  disconnected_at: string | null
  created_at: string
  updated_at: string
}

/** Status payload returned by GET /api/extensions/ext/woocommerce/status. */
export interface WooCommerceStatusResponse {
  configured: boolean
  connection: Pick<
    WooCommerceConnection,
    | 'id'
    | 'status'
    | 'store_url'
    | 'store_name'
    | 'currency'
    | 'error_message'
    | 'connected_at'
    | 'transaction_sync_enabled'
    | 'last_order_synced_at'
  > | null
}

/**
 * Minimal wc/v3 order shape consumed by the feed. All money fields are strings
 * in the order's `currency`; every date has a `_gmt` twin and the feed only
 * ever reads the `_gmt` variants (store-local dates shift with DST).
 */
export interface WooOrder {
  id: number
  /** Display order number; usually the id, but plugins can renumber. */
  number: string
  status: string
  currency: string
  /** Grand total actually charged (gross, incl. tax and shipping). */
  total: string
  total_tax: string
  prices_include_tax: boolean
  date_created_gmt: string
  date_modified_gmt: string
  /** Set when payment completed; the feed's inclusion criterion and row date. */
  date_paid_gmt: string | null
  payment_method: string
  payment_method_title: string
  /** Gateway charge reference; join key for later gateway-side reconciliation. */
  transaction_id: string
  /** Summary of refunds against this order; totals are negative strings. */
  refunds: Array<{ id: number; reason: string; total: string }>
}

/** Minimal wc/v3 order-refund shape (GET /orders/{id}/refunds). */
export interface WooRefund {
  id: number
  /** Refund amount as a positive string. */
  amount: string
  reason: string
  date_created_gmt: string
}

/** Store metadata read at connect time. */
export interface WooStoreInfo {
  /** WordPress site title from GET {store}/wp-json/ (public, unauthenticated). */
  name: string | null
  /** ISO 4217 store currency, when readable. */
  currency: string | null
  prices_include_tax: boolean | null
  wc_version: string | null
}
