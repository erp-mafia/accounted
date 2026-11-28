import type { ChannelOption, EditorChannel } from '@/lib/invoices/editor/channel'

/**
 * The ways an invoice can go out to a customer, in the recommended order.
 * A company may save its own order (company_settings.invoice_send_order):
 * the invoice editor then picks the first way in it that the invoice can
 * use. Each way is also the name of the editor channel it selects.
 */
export const SEND_ORDER_WAYS = ['peppol', 'kivra', 'billo', 'email'] as const

export type SendOrderWay = (typeof SEND_ORDER_WAYS)[number]

export function isSendOrderWay(value: unknown): value is SendOrderWay {
  return typeof value === 'string' && (SEND_ORDER_WAYS as readonly string[]).includes(value)
}

/** A saved order: a non-empty list of distinct ways. */
export function isValidSendOrder(value: unknown): value is SendOrderWay[] {
  if (!Array.isArray(value) || value.length === 0) return false
  if (!value.every(isSendOrderWay)) return false
  return new Set(value).size === value.length
}

/** The saved order as the editor reads it: null when none is saved or the stored value is not a valid order. */
export function parseSendOrder(value: unknown): SendOrderWay[] | null {
  return isValidSendOrder(value) ? [...value] : null
}

/** A customer's own way (customers.invoice_send_way) as the editor reads it: null when none is set or the stored value is not a way. */
export function parseSendWay(value: unknown): SendOrderWay | null {
  return isSendOrderWay(value) ? value : null
}

/**
 * The order the editor tries for an invoice to one customer: the customer's
 * own way ("Skickas som", customers.invoice_send_way) first, then the
 * company's saved order (company_settings.invoice_send_order) without it.
 * Null when neither is set, so the editor keeps its own default.
 *
 * A customer's way the invoice cannot use (no Peppol id for the buyer, no
 * email address) is passed over by defaultChannelByOrder, and what decides
 * then is exactly what decides for a customer without one: the company's
 * order, or with no order the editor's default.
 */
export function sendOrderForCustomer(customerWay: unknown, companyOrder: unknown): SendOrderWay[] | null {
  const way = parseSendWay(customerWay)
  const order = parseSendOrder(companyOrder)
  if (!way) return order
  return [way, ...(order ?? []).filter((other) => other !== way)]
}

/**
 * The channel the editor acts on without a pick by hand, under a saved
 * order: the first way in the order that is listed and choosable for this
 * invoice. When none is, `fallback` (the editor's default without an order).
 */
export function defaultChannelByOrder(
  options: readonly ChannelOption[],
  order: readonly SendOrderWay[],
  fallback: EditorChannel,
): EditorChannel {
  for (const way of order) {
    if (options.some((option) => option.channel === way && option.available)) return way
  }
  return fallback
}

/**
 * The ways this company can use: e-faktura when it can send e-fakturor (the
 * answer the editor lists Peppol by), each mailbox when it sends through that
 * provider, email always. In the recommended order.
 */
export function availableSendOrderWays(canSendPeppol: boolean, mailboxProviders: readonly string[]): SendOrderWay[] {
  return SEND_ORDER_WAYS.filter((way) => {
    if (way === 'peppol') return canSendPeppol
    if (way === 'email') return true
    return mailboxProviders.includes(way)
  })
}

/** An order is only there to choose when the company can use at least two ways. */
export function hasOrderToChoose(available: readonly SendOrderWay[]): boolean {
  return available.length >= 2
}

/** One line of the order list: a way the company can use, switched on or off. */
export interface SendOrderRow {
  way: SendOrderWay
  on: boolean
}

/**
 * E-post is in every order and cannot be switched off: every customer with an
 * address can take it, and without it the editor would fall back to email
 * anyway. It can still be moved.
 */
export function isAlwaysOnWay(way: SendOrderWay): boolean {
  return way === 'email'
}

/**
 * The rows to start from: with a saved order its ways first, in its order and
 * on, then the other available ways, off; without one every available way in
 * the recommended order, on. A saved way the company cannot use any more is
 * left out, and e-post is on even where a saved order left it out.
 */
export function initialSendOrderRows(available: readonly SendOrderWay[], saved: readonly SendOrderWay[] | null): SendOrderRow[] {
  if (!saved) return available.map((way) => ({ way, on: true }))
  const kept = saved.filter((way) => available.includes(way))
  const alwaysOn = available.filter((way) => isAlwaysOnWay(way) && !kept.includes(way))
  const on = [...kept, ...alwaysOn]
  return [
    ...on.map((way) => ({ way, on: true })),
    ...available.filter((way) => !on.includes(way)).map((way) => ({ way, on: false })),
  ]
}

/** The row one place up (-1) or down (1); a row at the end it moves toward stays. */
export function moveSendOrderRow(rows: readonly SendOrderRow[], way: SendOrderWay, step: -1 | 1): SendOrderRow[] {
  const index = rows.findIndex((row) => row.way === way)
  const target = index + step
  if (index < 0 || target < 0 || target >= rows.length) return [...rows]
  const next = [...rows]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** A way switched on or off; e-post stays on. */
export function toggleSendOrderRow(rows: readonly SendOrderRow[], way: SendOrderWay): SendOrderRow[] {
  if (isAlwaysOnWay(way)) return [...rows]
  return rows.map((row) => (row.way === way ? { ...row, on: !row.on } : row))
}

/** The order the rows stand for: the ways switched on, top to bottom. */
export function orderOfRows(rows: readonly SendOrderRow[]): SendOrderWay[] {
  return rows.filter((row) => row.on).map((row) => row.way)
}
