/**
 * Shared result shape for the kundorder services. Mirrors
 * buildInvoiceWriteData(): a domain failure carries a structured-error code
 * (map via errorResponseFromCode) and an unexpected DB failure carries the
 * raw error (map via errorResponse), so route handlers and the MCP commit
 * executor translate identically.
 */
export type ServiceFailure =
  | { ok: false; code: string; details?: Record<string, unknown> }
  | { ok: false; dbError: unknown }

export type ServiceResult<T> = ({ ok: true } & T) | ServiceFailure

export function fail(code: string, details?: Record<string, unknown>): ServiceFailure {
  return details ? { ok: false, code, details } : { ok: false, code }
}

export function failDb(dbError: unknown): ServiceFailure {
  return { ok: false, dbError }
}

/**
 * The over-invoice, quantity-floor and delivered-within-ordered guards live
 * in Postgres (migration 20260902130000). They raise with a stable
 * SALES_ORDER_* prefix in the message so the service layer can map a race
 * that slipped past the pre-check onto the same structured code the
 * pre-check uses.
 */
export function codeFromPgError(error: unknown): string | null {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : ''
  if (message.includes('SALES_ORDER_OVER_INVOICED')) return 'SALES_ORDER_OVER_INVOICED'
  if (message.includes('SALES_ORDER_QUANTITY_BELOW_INVOICED')) return 'SALES_ORDER_QUANTITY_BELOW_INVOICED'
  if (message.includes('sales_order_items_delivered_within_ordered')) return 'SALES_ORDER_OVER_DELIVERED'
  if (message.includes('SALES_ORDER_ITEM_NOT_FOUND')) return 'SALES_ORDER_LINE_NOT_FOUND'
  // Migration 20260908165000: one live kundorder per source document, and a
  // quote with a live converted invoice cannot get a live order. Raised by
  // the partial unique index and the source guard trigger when a concurrent
  // conversion slipped past the service pre-checks.
  if (message.includes('uq_sales_orders_one_live_per_source')) return 'SALES_ORDER_SOURCE_ALREADY_CONVERTED'
  if (message.includes('INVOICE_QUOTE_ALREADY_INVOICED')) return 'INVOICE_QUOTE_ALREADY_INVOICED'
  // RESTRICT FKs: a line or order that a (possibly cancelled) invoice still
  // references cannot be removed; the derived invoiced quantity is 0 for a
  // cancelled invoice, so the service pre-checks let the delete through and
  // the FK is the authority.
  if (message.includes('invoice_items_sales_order_item_id_fkey')) return 'SALES_ORDER_LINE_LOCKED'
  if (message.includes('invoices_sales_order_id_fkey')) return 'SALES_ORDER_HAS_INVOICES'
  return null
}
