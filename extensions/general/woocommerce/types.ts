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

/** Connection fields safe for the browser (never encrypted credentials). */
export type WooCommerceConnectionStatus = Pick<
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
>

/** Status payload returned by GET /api/extensions/ext/woocommerce/status. */
export interface WooCommerceStatusResponse {
  configured: boolean
  /** First entry of `connections`; kept for the old single-store shape. */
  connection: WooCommerceConnectionStatus | null
  /** Multi-store: every active connection (or the latest inactive row). */
  connections: WooCommerceConnectionStatus[]
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
  /** Set when payment completed; drives is_paid and the paid date. */
  date_paid_gmt: string | null
  payment_method: string
  payment_method_title: string
  /** Gateway charge reference; join key for later gateway-side reconciliation. */
  transaction_id: string
  /** Summary of refunds against this order; totals are negative strings. */
  refunds: Array<{ id: number; reason: string; total: string }>
  /**
   * The fields below always ride along in the wc/v3 order payload; the feed
   * historically discarded them at map time. The Orders page persists them
   * (customer, per-rate VAT, line snapshot), so the type now keeps them.
   * All are optional-tolerant at runtime: hardened stores and old WC
   * versions can serve partial payloads.
   */
  billing?: {
    first_name?: string
    last_name?: string
    company?: string
    email?: string
    /** ISO 3166-1 alpha-2 (e.g. 'SE'); drives the 0%-sale export/EU hint. */
    country?: string
  }
  line_items?: Array<{
    id: number
    name: string
    quantity: number
    /** Line net total after discounts, excl. tax. */
    total: string
    total_tax: string
    taxes?: Array<{ id: number; total: string }>
  }>
  tax_lines?: Array<{
    rate_id: number
    rate_percent?: number
    label?: string
    tax_total: string
    shipping_tax_total: string
  }>
  shipping_lines?: Array<{
    method_title?: string
    total: string
    total_tax: string
    taxes?: Array<{ id: number; total: string }>
  }>
  /** Payment surcharges / plugin fees; part of order.total like shipping. */
  fee_lines?: Array<{
    name?: string
    total: string
    total_tax: string
    taxes?: Array<{ id: number; total: string }>
  }>
  meta_data?: Array<{ key: string; value: unknown }>
}

/** wc/v3 order-refund shape (GET /orders/{id}/refunds). */
export interface WooRefund {
  id: number
  /** Refund amount as a positive string. */
  amount: string
  reason: string
  date_created_gmt: string
  /**
   * Per-line refund allocation with NEGATIVE totals, present when the
   * merchant refunded specific lines. Amount-only refunds ship an empty
   * array; the sync then prorates VAT from the parent order's breakdown.
   */
  line_items?: Array<{
    id: number
    name?: string
    quantity?: number
    total: string
    total_tax: string
    taxes?: Array<{ id: number; total: string }>
  }>
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
