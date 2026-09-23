import type { SalesOrderItem, SalesOrderProgress } from '@/types'

/**
 * Quantity arithmetic on order lines.
 *
 * Postgres stores quantities as exact numeric; JavaScript does not. A
 * remaining quantity computed as `7.5 - 6.9` in doubles is 0.5999999999999996,
 * which the DB then refuses ("0.6 > remaining") or, if sent as-is, lands as
 * an invoice quantity the customer never ordered. Every derived quantity is
 * therefore rounded to QTY_DECIMALS before it is compared or persisted, and
 * comparisons use QTY_EPSILON so 0.1 + 0.2 style drift never decides a case
 * that the exact numeric would decide the other way.
 */
export const QTY_DECIMALS = 6
const QTY_SCALE = 10 ** QTY_DECIMALS
export const QTY_EPSILON = 1 / QTY_SCALE / 2

export function roundQty(n: number): number {
  if (n === 0) return 0
  return Math.round((n + Number.EPSILON) * QTY_SCALE) / QTY_SCALE
}

/** a > b beyond quantity precision. */
export function qtyGreater(a: number, b: number): boolean {
  return a - b > QTY_EPSILON
}

/**
 * Derived per-axis progress of an order. Delivery and invoicing are
 * independent: an order is often partially delivered and partially
 * invoiced at the same time, which is why neither is a header status.
 *
 * Only product lines with a positive quantity count; text rows and zero
 * quantity rows carry no progress.
 */
function progressOf(items: SalesOrderItem[], pick: (item: SalesOrderItem) => number): SalesOrderProgress {
  const lines = items.filter((i) => i.line_type !== 'text' && i.quantity > 0)
  if (lines.length === 0) return 'none'
  let any = false
  let all = true
  for (const line of lines) {
    const done = pick(line)
    if (done > 0) any = true
    if (qtyGreater(line.quantity, done)) all = false
  }
  if (all) return 'full'
  return any ? 'partial' : 'none'
}

export function deliveryProgress(items: SalesOrderItem[]): SalesOrderProgress {
  return progressOf(items, (i) => i.delivered_qty)
}

export function invoicingProgress(items: SalesOrderItem[]): SalesOrderProgress {
  return progressOf(items, (i) => i.invoiced_qty ?? 0)
}

/** Attach invoiced_qty / remaining_qty (both rounded to quantity precision) from the RPC rows. */
export function withInvoicedQuantities(
  items: SalesOrderItem[],
  invoiced: Map<string, number>,
): SalesOrderItem[] {
  return items.map((item) => {
    const invoicedQty = roundQty(invoiced.get(item.id) ?? 0)
    return {
      ...item,
      invoiced_qty: invoicedQty,
      remaining_qty: Math.max(0, roundQty(item.quantity - invoicedQty)),
    }
  })
}
