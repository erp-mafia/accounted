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

/** What reaches a customer: the answers of the three recipient checks. */
export interface CustomerReach {
  /** peppolRecipientIdentifiable */
  peppol: boolean
  /** mailboxRecipientIdentifiable: serves Kivra and Billo alike */
  mailbox: boolean
  /** A usable email address */
  email: boolean
}

export interface CustomerReachCount {
  reach: CustomerReach
  count: number
}

function wayReaches(way: SendOrderWay, reach: CustomerReach): boolean {
  if (way === 'peppol') return reach.peppol
  if (way === 'email') return reach.email
  return reach.mailbox
}

export interface OrderSplit {
  /** Customers each way reaches first, in the given order. */
  perWay: Record<SendOrderWay, number>
  /** Customers no way in the order reaches. */
  none: number
  total: number
}

/**
 * How the customers split over the ways of an order: each customer counts
 * for the first way in the order that reaches it, or for none. The order
 * holds only the ways switched on.
 */
export function splitCustomers(counts: readonly CustomerReachCount[], order: readonly SendOrderWay[]): OrderSplit {
  const perWay: Record<SendOrderWay, number> = { peppol: 0, kivra: 0, billo: 0, email: 0 }
  let none = 0
  let total = 0
  for (const { reach, count } of counts) {
    total += count
    const way = order.find((candidate) => wayReaches(candidate, reach))
    if (way) perWay[way] += count
    else none += count
  }
  return { perWay, none, total }
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
 * The rows to start from: with a saved order its ways first, in its order and
 * on, then the other available ways, off; without one every available way in
 * the recommended order, on. A saved way the company cannot use any more is
 * left out.
 */
export function initialSendOrderRows(available: readonly SendOrderWay[], saved: readonly SendOrderWay[] | null): SendOrderRow[] {
  if (!saved) return available.map((way) => ({ way, on: true }))
  const kept = saved.filter((way) => available.includes(way))
  return [
    ...kept.map((way) => ({ way, on: true })),
    ...available.filter((way) => !kept.includes(way)).map((way) => ({ way, on: false })),
  ]
}

/** The row one place up; the first row stays. */
export function moveSendOrderRowUp(rows: readonly SendOrderRow[], way: SendOrderWay): SendOrderRow[] {
  const index = rows.findIndex((row) => row.way === way)
  if (index <= 0) return [...rows]
  const next = [...rows]
  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
  return next
}

export function toggleSendOrderRow(rows: readonly SendOrderRow[], way: SendOrderWay): SendOrderRow[] {
  return rows.map((row) => (row.way === way ? { ...row, on: !row.on } : row))
}

/** The order the rows stand for: the ways switched on, top to bottom. Empty when every way is off. */
export function orderOfRows(rows: readonly SendOrderRow[]): SendOrderWay[] {
  return rows.filter((row) => row.on).map((row) => row.way)
}
