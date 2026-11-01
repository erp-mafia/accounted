import type { SalesOrderProgress, SalesOrderStatus } from '@/types'

/**
 * Presentation maps for kundorder status and progress. Chips mark exceptions
 * (design.md convention 5): a draft and a cancelled order deviate from the
 * normal flow and get a Badge; confirmed and completed render as muted text.
 */
export const STATUS_LABEL_KEY: Record<SalesOrderStatus, string> = {
  draft: 'status_draft',
  confirmed: 'status_confirmed',
  completed: 'status_completed',
  cancelled: 'status_cancelled',
}

export const STATUS_BADGE_VARIANT: Partial<
  Record<SalesOrderStatus, 'outline' | 'destructive'>
> = {
  draft: 'outline',
  cancelled: 'destructive',
}

export const DELIVERY_LABEL_KEY: Record<SalesOrderProgress, string> = {
  none: 'delivery_none',
  partial: 'delivery_partial',
  full: 'delivery_full',
}

export const INVOICING_LABEL_KEY: Record<SalesOrderProgress, string> = {
  none: 'invoicing_none',
  partial: 'invoicing_partial',
  full: 'invoicing_full',
}

/** Renders a quantity without trailing zeros (2 -> "2", 2.5 -> "2,5" via toLocaleString). */
export function formatQty(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '0'
  return n.toLocaleString('sv-SE', { maximumFractionDigits: 3 })
}
