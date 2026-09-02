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
  return null
}
