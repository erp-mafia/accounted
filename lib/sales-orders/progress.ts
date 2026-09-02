import type { SalesOrderItem, SalesOrderProgress } from '@/types'

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
    if (done < line.quantity) all = false
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

/** Attach invoiced_qty / remaining_qty from the RPC rows onto the items. */
export function withInvoicedQuantities(
  items: SalesOrderItem[],
  invoiced: Map<string, number>,
): SalesOrderItem[] {
  return items.map((item) => {
    const invoicedQty = invoiced.get(item.id) ?? 0
    return {
      ...item,
      invoiced_qty: invoicedQty,
      remaining_qty: Math.max(0, item.quantity - invoicedQty),
    }
  })
}
