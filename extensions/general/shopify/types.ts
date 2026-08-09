/** Row shape of public.shopify_connections. */
export interface ShopifyConnection {
  id: string
  company_id: string
  user_id: string
  /** Normalized myshopify.com domain, lowercased, no scheme/path. */
  shop_domain: string
  shop_name: string | null
  /**
   * Dev Dashboard custom-app credentials (client credentials grant). Shopify
   * discontinued revealable admin API tokens for new custom apps on
   * 2026-01-01; the merchant pastes the app's client id/secret instead and
   * the server exchanges them for a short-lived (24h) access token per run.
   */
  client_id_encrypted: string | null
  client_secret_encrypted: string | null
  status: 'pending' | 'active' | 'revoked' | 'error'
  /** ISO 4217 shop currency read at connect time. */
  currency: string | null
  /** Opt-in: nightly order-feed cron (the manual sync button ignores it). */
  transaction_sync_enabled: boolean
  /** Order-polling cursor (max updatedAt processed). */
  last_order_synced_at: string | null
  error_message: string | null
  connected_at: string | null
  disconnected_at: string | null
  created_at: string
  updated_at: string
}

/** Status payload returned by GET /api/extensions/ext/shopify/status. */
export interface ShopifyStatusResponse {
  configured: boolean
  connection: Pick<
    ShopifyConnection,
    | 'id'
    | 'status'
    | 'shop_domain'
    | 'shop_name'
    | 'currency'
    | 'error_message'
    | 'connected_at'
    | 'transaction_sync_enabled'
    | 'last_order_synced_at'
  > | null
}

/**
 * GraphQL MoneyBag, shop-currency side only. Amounts are decimal strings in
 * major units for every currency (also zero-decimal ones like JPY), so
 * parseFloat is correct universally: never divide by 100.
 */
export interface ShopifyMoneyBag {
  shopMoney: { amount: string; currencyCode: string }
}

/** Minimal refund shape; Shopify returns refunds inline on the order. */
export interface ShopifyRefund {
  legacyResourceId: string
  createdAt: string
  totalRefundedSet: ShopifyMoneyBag
}

/**
 * Minimal GraphQL Admin API order shape consumed by the feed. All timestamps
 * are ISO 8601 UTC with a Z suffix.
 */
export interface ShopifyOrder {
  /** Numeric order id as a string; stable join key for external_id. */
  legacyResourceId: string
  /** Display name incl. the # prefix (e.g. "#1042"); plugins can renumber. */
  name: string
  /** Test-gateway order (dev stores, Bogus Gateway); never real revenue. */
  test: boolean
  /** When payment was captured; the feed's row date. */
  processedAt: string
  updatedAt: string
  displayFinancialStatus: string | null
  /** Gateway display names; join key for gateway-side reconciliation. */
  paymentGatewayNames: string[]
  /** Grand total actually charged (gross, incl. tax and shipping). */
  totalPriceSet: ShopifyMoneyBag
  refunds: ShopifyRefund[]
}

/** Shop metadata read at connect time. */
export interface ShopifyShopInfo {
  name: string | null
  /** ISO 4217 shop currency. */
  currency: string | null
}
