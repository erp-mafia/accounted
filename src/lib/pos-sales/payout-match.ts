import { daysBetweenIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'

/**
 * Which bank rows are the till's card and Swish money arriving.
 *
 * A booked kassa day debits card and Swish to the clearing account (1686 by
 * default, lib/pos-sales/settings.ts). The money then reaches the bank as
 * ordinary rows that nothing linked to the day, so a row booked as sales
 * counts the revenue twice. This module says which rows are that money, so
 * they can be proposed against the clearing account. Pure:
 * lib/pos-sales/payout-proposals.ts reads the days and the rows and turns a
 * match into a proposal. Nothing provider- or bank-specific: it works off the
 * day model every POS provider delivers (tenders, receipts) and the row's
 * date and amount.
 *
 * Swish. The bank shows every Swish payment as its own row, for exactly what
 * the receipt took (gross + tips), dated the day it was paid or the next
 * banking day. A row matches one Swish receipt to the öre, paid 0 to
 * SWISH_MAX_LAG_DAYS days before the row: a weekend lands on Monday (lag 2
 * or 3), and the longest Swedish run of non-banking days (Christmas Eve to
 * the Sunday after, or Easter) puts five days between a payment and its
 * booking date. The closest receipt wins, each receipt at most once, and
 * rows already booked against the tender account claim theirs first.
 *
 * Card. The acquirer pays one row per batch, one to a few banking days after
 * the business day. Payouts run a little under the day's card tender (in
 * the data this was built from 98.8 % to 99.4 %: the batch closes before the
 * restaurant's business day does, so its tail lands in the next payout) and
 * now and then above it (up to about +4.6 %, the next payout catching that
 * tail up); over weeks they sum to the card total, so fees are not netted.
 * Friday and Saturday arrive together on Monday. A row fits either
 *   - the card tender of one to CARD_MAX_RUN_DAYS consecutive open days,
 *     the last of them CARD_MIN_LAG_DAYS to CARD_MAX_LAG_DAYS before the
 *     row, within CARD_RUN_FIT (0.98 to 1.01 of the days: a 0.8 point
 *     margin under the lowest ratio seen, a small catch-up above), or
 *   - the running open card balance up to such a day (every day's unpaid
 *     part, tails included), within CARD_BALANCE_FIT (0.98 to 1.005: what
 *     is open less the newest day's own tail of about 1 %, never more than
 *     is open, and never looser than the days fit underneath). This is what
 *     catches the larger payouts.
 * The days fit is preferred: it names the days. A fit is a proposal for a
 * person to review, never more. Rows are taken in date order, booked ones
 * first on a date, and each fit pays its days off (oldest first), so a day
 * is paid once. A row that fits nothing pays nothing off: a payout for days
 * before the window, or a booking nobody can explain, must not shift every
 * later fit.
 */

/** Days between a Swish payment and the bank row it arrives as, inclusive. */
export const SWISH_MAX_LAG_DAYS = 5
/** Days between a card business day and its payout. */
export const CARD_MIN_LAG_DAYS = 1
export const CARD_MAX_LAG_DAYS = 5
/** Days one card payout may cover (Friday, Saturday and Sunday on Monday). */
export const CARD_MAX_RUN_DAYS = 3
/** The oldest day a payout's run may start on, in days before the row. */
export const CARD_MAX_RUN_SPAN_DAYS = 7
/** Payout over the run's open card tender. */
export const CARD_RUN_FIT = { min: 0.98, max: 1.01 } as const
/** Payout over the open card balance up to a day. */
export const CARD_BALANCE_FIT = { min: 0.98, max: 1.005 } as const
/** A day is open while at least this share of its card tender is unpaid. */
export const CARD_OPEN_SHARE = 0.5

export interface PayoutCardDay {
  day_id: string
  connection_id: string
  business_date: string
  /** The day's card tender, tips included. */
  card: number
}

export interface PayoutSwishReceipt {
  day_id: string
  connection_id: string
  business_date: string
  number: string
  /** The Swedish calendar date the receipt was paid on. */
  paid_on: string
  /** gross + tips: what the bank receives. */
  amount: number
}

export interface PayoutBankRow {
  id: string
  date: string
  amount: number
  /** Already booked against the tender account: it pays its receipt or days off first, and is never proposed. */
  booked: boolean
  /** May be the Swish payment of one receipt (an open row: on a rail Swish arrives on). */
  swish: boolean
  /** May be a card payout (an open row: no counterparty name, on a rail a payout arrives on). */
  card: boolean
}

export type PayoutMatch =
  | {
      kind: 'swish'
      fit: 'receipt'
      connection_id: string
      day_id: string
      business_date: string
      receipt_number: string
      expected: number
    }
  | {
      kind: 'card'
      fit: 'days' | 'balance'
      connection_id: string
      day_ids: string[]
      business_dates: string[]
      expected: number
    }

export interface PayoutMatchInput {
  cardDays: readonly PayoutCardDay[]
  receipts: readonly PayoutSwishReceipt[]
  rows: readonly PayoutBankRow[]
}

const amountKey = (n: number): string => String(roundOre(n))

const byDateBookedFirst = (a: PayoutBankRow, b: PayoutBankRow): number =>
  a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.booked !== b.booked ? (a.booked ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

function compareReceipts(rowDate: string) {
  return (a: PayoutSwishReceipt, b: PayoutSwishReceipt): number => {
    const lag = daysBetweenIso(a.paid_on, rowDate) - daysBetweenIso(b.paid_on, rowDate)
    if (lag !== 0) return lag
    if (a.business_date !== b.business_date) return a.business_date < b.business_date ? -1 : 1
    if (a.number !== b.number) return a.number < b.number ? -1 : 1
    return a.day_id < b.day_id ? -1 : a.day_id > b.day_id ? 1 : 0
  }
}

interface OpenDay extends PayoutCardDay {
  open: number
}

interface CardFit {
  fit: 'days' | 'balance'
  connection_id: string
  /** The days the fit names (the run, or every day up to the cut). */
  days: OpenDay[]
  expected: number
  score: number
}

const isOpen = (d: OpenDay): boolean => d.open > 0 && d.open >= d.card * CARD_OPEN_SHARE

/** The best fit of `row` against one connection's days (ascending), or null. */
function fitOnConnection(days: OpenDay[], row: PayoutBankRow): CardFit | null {
  const lagOf = (d: OpenDay) => daysBetweenIso(d.business_date, row.date)
  const payable = (d: OpenDay) => lagOf(d) >= CARD_MIN_LAG_DAYS && lagOf(d) <= CARD_MAX_LAG_DAYS
  let best: CardFit | null = null
  const better = (a: CardFit, b: CardFit | null) =>
    !b ||
    a.score < b.score - 1e-9 ||
    (Math.abs(a.score - b.score) <= 1e-9 && (a.days.length < b.days.length ||
      (a.days.length === b.days.length && a.days[a.days.length - 1].business_date > b.days[b.days.length - 1].business_date)))

  for (let end = 0; end < days.length; end++) {
    if (!payable(days[end]) || !isOpen(days[end])) continue
    let sum = 0
    for (let len = 1; len <= CARD_MAX_RUN_DAYS && end - len + 1 >= 0; len++) {
      const first = days[end - len + 1]
      if (!isOpen(first) || lagOf(first) > CARD_MAX_RUN_SPAN_DAYS) break
      sum = roundOre(sum + first.open)
      const ratio = row.amount / sum
      if (ratio < CARD_RUN_FIT.min || ratio > CARD_RUN_FIT.max) continue
      const fit: CardFit = {
        fit: 'days',
        connection_id: first.connection_id,
        days: days.slice(end - len + 1, end + 1),
        expected: sum,
        score: Math.abs(1 - ratio),
      }
      if (better(fit, best)) best = fit
    }
  }
  if (best) return best

  let balance = 0
  for (let cut = 0; cut < days.length; cut++) {
    balance = roundOre(balance + days[cut].open)
    if (!payable(days[cut]) || balance <= 0) continue
    const ratio = row.amount / balance
    if (ratio < CARD_BALANCE_FIT.min || ratio > CARD_BALANCE_FIT.max) continue
    const fit: CardFit = {
      fit: 'balance',
      connection_id: days[cut].connection_id,
      days: days.slice(0, cut + 1).filter((d) => d.open > 0),
      expected: balance,
      score: Math.abs(1 - ratio),
    }
    if (better(fit, best)) best = fit
  }
  return best
}

/** Pay `amount` off `days` oldest first, never below zero; what is left over is returned. */
function payOff(days: OpenDay[], amount: number): number {
  let left = roundOre(amount)
  for (const day of days) {
    if (left <= 0) break
    const take = Math.min(day.open, left)
    day.open = roundOre(day.open - take)
    left = roundOre(left - take)
  }
  return left
}

/**
 * The open rows that are the till's money, keyed by row id. Booked rows are
 * taken into account (they pay off what they cleared) and never returned.
 */
export function matchPosPayouts(input: PayoutMatchInput): Map<string, PayoutMatch> {
  const matches = new Map<string, PayoutMatch>()

  // ── Swish: one receipt per row, to the öre ──
  const pool = new Map<string, PayoutSwishReceipt[]>()
  for (const r of input.receipts) {
    if (!(r.amount > 0)) continue
    const key = amountKey(r.amount)
    const list = pool.get(key)
    if (list) list.push(r)
    else pool.set(key, [r])
  }
  const claimed = new Set<PayoutSwishReceipt>()
  const swished = new Set<string>()
  const sorted = [...input.rows].sort(byDateBookedFirst)
  const swishOrder = [...sorted.filter((r) => r.booked && r.swish), ...sorted.filter((r) => !r.booked && r.swish)]
  for (const row of swishOrder) {
    const candidates = (pool.get(amountKey(row.amount)) ?? []).filter((r) => {
      if (claimed.has(r)) return false
      const lag = daysBetweenIso(r.paid_on, row.date)
      return lag >= 0 && lag <= SWISH_MAX_LAG_DAYS
    })
    if (candidates.length === 0) continue
    const receipt = candidates.sort(compareReceipts(row.date))[0]
    claimed.add(receipt)
    swished.add(row.id)
    if (!row.booked) {
      matches.set(row.id, {
        kind: 'swish',
        fit: 'receipt',
        connection_id: receipt.connection_id,
        day_id: receipt.day_id,
        business_date: receipt.business_date,
        receipt_number: receipt.number,
        expected: roundOre(receipt.amount),
      })
    }
  }

  // ── Card: the days or the open balance a payout fits ──
  const byConnection = new Map<string, OpenDay[]>()
  for (const d of input.cardDays) {
    if (!(d.card > 0)) continue
    const list = byConnection.get(d.connection_id) ?? []
    list.push({ ...d, card: roundOre(d.card), open: roundOre(d.card) })
    byConnection.set(d.connection_id, list)
  }
  const connections = [...byConnection.keys()].sort()
  for (const id of connections) byConnection.get(id)!.sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0))

  for (const row of sorted) {
    if (swished.has(row.id) || !row.card || !(row.amount > 0)) continue
    let best: CardFit | null = null
    for (const id of connections) {
      const fit = fitOnConnection(byConnection.get(id)!, row)
      if (!fit) continue
      if (!best || (fit.fit === 'days' && best.fit === 'balance') || (fit.fit === best.fit && fit.score < best.score - 1e-9)) best = fit
    }
    if (!best) continue
    const days = byConnection.get(best.connection_id)!
    const left = payOff(best.days, row.amount)
    // A run paid above its days: the rest pays off the older tails.
    if (left > 0 && best.fit === 'days') {
      const firstDate = best.days[0].business_date
      payOff(days.filter((d) => d.business_date < firstDate), left)
    }
    if (!row.booked) {
      matches.set(row.id, {
        kind: 'card',
        fit: best.fit,
        connection_id: best.connection_id,
        day_ids: best.days.map((d) => d.day_id),
        business_dates: best.days.map((d) => d.business_date),
        expected: best.expected,
      })
    }
  }
  return matches
}
