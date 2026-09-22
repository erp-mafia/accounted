import type {
  WebshopOrderLineItem,
  WebshopOrderRowType,
  WebshopPlatform,
  WebshopVatBreakdownLine,
} from '@/types'

/**
 * Row shape the platform syncs (woocommerce/shopify extensions) hand to
 * upsertWebshopOrders(). Everything the sync knows about one bookable money
 * event; the service owns FX enrichment, legacy cross-marking and the
 * frozen-row rules, so none of those fields appear here.
 */
export interface WebshopOrderUpsert {
  platform: WebshopPlatform
  store_scope: string
  store_label: string | null
  connection_id: string | null
  row_type: WebshopOrderRowType
  /**
   * external_id of the parent order for refund rows; resolved to
   * parent_order_id by the service (the parent may be in the same batch or
   * already in the table from an earlier run). Null on order rows.
   */
  parent_external_id: string | null
  external_id: string
  platform_order_id: string
  order_number: string
  status: string
  is_paid: boolean
  order_date: string
  paid_date: string | null
  currency: string
  total: number
  total_tax: number
  vat_breakdown: WebshopVatBreakdownLine[]
  line_items: WebshopOrderLineItem[]
  customer_name: string | null
  customer_company: string | null
  customer_email: string | null
  customer_orgnr: string | null
  customer_country: string | null
  payment_method: string | null
  payment_method_title: string | null
  gateway_reference: string | null
  refunded_total: number
}

export interface WebshopOrderRemovalResult {
  /** Rows deleted (unfrozen order rows; unfrozen refund children cascade). */
  removed: number
  errors: number
  /** First error encountered, surfaced for the sync summary/logs. */
  firstError?: { message: string; code?: string | null }
}

export interface WebshopOrderUpsertResult {
  inserted: number
  updated: number
  /** Existing rows whose incoming payload carried no change. */
  unchanged: number
  /** Booked/invoiced rows whose financials drifted remotely; flagged, not updated. */
  frozenFlagged: number
  /** Rows linked to an already-imported legacy transactions feed row. */
  crossMarked: number
  errors: number
  /** First error encountered, surfaced for the sync summary/logs. */
  firstError?: { message: string; code?: string | null }
}
