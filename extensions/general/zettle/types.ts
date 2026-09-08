/** Row shape of public.zettle_connections. */
export interface ZettleConnection {
  id: string
  company_id: string
  user_id: string
  /**
   * Merchant organization UUID from GET users/self. Frozen into store_scope /
   * external_id so disconnect/reconnect of the same merchant stays deduped.
   */
  organization_uuid: string | null
  organization_name: string | null
  /** AES-256-GCM encrypted OAuth refresh token. */
  refresh_token_encrypted: string | null
  oauth_state: string | null
  status: 'pending' | 'active' | 'revoked' | 'error'
  currency: string | null
  /** Opt-in: nightly purchase-feed cron (the manual sync button ignores it). */
  transaction_sync_enabled: boolean
  /** Purchase-polling cursor (max purchase timestamp processed). */
  last_order_synced_at: string | null
  error_message: string | null
  connected_at: string | null
  disconnected_at: string | null
  created_at: string
  updated_at: string
}

/** Status payload returned by GET /api/extensions/ext/zettle/status. */
export interface ZettleStatusResponse {
  configured: boolean
  connection: Pick<
    ZettleConnection,
    | 'id'
    | 'status'
    | 'organization_uuid'
    | 'organization_name'
    | 'currency'
    | 'error_message'
    | 'connected_at'
    | 'transaction_sync_enabled'
    | 'last_order_synced_at'
  > | null
}

/** One product line on a Zettle purchase. */
export interface ZettleProduct {
  quantity: string
  type?: string
  name?: string | null
  variantName?: string | null
  vatPercentage?: number | null
  /** Net (excl. VAT) in minor currency units. */
  rowTaxableAmount?: number | null
  unitPrice?: number | null
  unitName?: string | null
  comment?: string | null
}

/** One payment on a Zettle purchase. */
export interface ZettlePayment {
  uuid?: string
  type: string
  amount?: number
  gratuityAmount?: number
}

/** Optional purchase-level service charge (e.g. shipping). */
export interface ZettleServiceCharge {
  amount: number
  title?: string | null
  vatPercentage?: number | null
  quantity?: string | null
}

/**
 * Minimal Purchase API v2 shape consumed by the feed. Timestamps are ISO 8601
 * (often with +0000 offset rather than Z).
 */
export interface ZettlePurchase {
  purchaseUUID1: string
  purchaseNumber?: number
  globalPurchaseNumber?: number
  /** Gross amount (incl. VAT) in minor units; negative on refunds. */
  amount: number
  /** VAT amount in minor units. */
  vatAmount?: number
  currency: string
  country?: string
  created?: string
  timestamp?: string
  refund?: boolean
  refunded?: boolean
  refundsPurchaseUUID1?: string | null
  products?: ZettleProduct[]
  payments?: ZettlePayment[]
  /** Map of VAT rate percent string → tax amount in minor units. */
  groupedVatAmounts?: Record<string, number> | null
  serviceCharge?: ZettleServiceCharge | null
  customAmountSale?: boolean
  source?: string
}

export interface ZettleUserSelf {
  uuid: string
  organizationUuid: string
}

export interface ZettleTokenPair {
  access_token: string
  refresh_token: string
  expires_in: number
}
