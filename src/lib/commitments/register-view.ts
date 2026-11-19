/**
 * How the Avtal och åtaganden page condenses what it lists. Pure and
 * client-safe (types only): the page and the Bolaget overview read the same
 * helpers, so the two never count payments differently.
 */
import type { ObligationView } from './types'

/** One agreement's upcoming payments as one line: the first one, and how many follow. */
export interface UpcomingPaymentLine {
  agreement_id: string
  title: string
  /** The first payment: a missed one (it lies in the past) before the next expected. */
  due_on: string
  amount: number
  currency: string
  direction: 'in' | 'out'
  missed: boolean
  /** The agreement's further payments in the same window. */
  more: number
}

/**
 * One line per agreement instead of one per payment: a loan with three
 * instalments in the window reads "date, amount, +2 till", not three rows.
 * Lines are ordered by their first date, then title.
 */
export function groupUpcomingPayments(payments: readonly ObligationView[]): UpcomingPaymentLine[] {
  const byAgreement = new Map<string, ObligationView[]>()
  for (const p of payments) byAgreement.set(p.agreement_id, [...(byAgreement.get(p.agreement_id) ?? []), p])
  const lines: UpcomingPaymentLine[] = []
  for (const rows of byAgreement.values()) {
    const sorted = [...rows].sort((a, b) => a.due_on.localeCompare(b.due_on) || a.obligation_id.localeCompare(b.obligation_id))
    const first = sorted[0]
    lines.push({
      agreement_id: first.agreement_id,
      title: first.agreement_title,
      due_on: first.due_on,
      amount: first.amount,
      currency: first.currency,
      direction: first.direction,
      missed: first.status === 'missed',
      more: sorted.length - 1,
    })
  }
  return lines.sort((a, b) => a.due_on.localeCompare(b.due_on) || a.title.localeCompare(b.title, 'sv'))
}

/**
 * The columns at least one row fills. A column that is empty on every row
 * (null, undefined or '') is left out of the table rather than drawn as a
 * blank strip.
 */
export function columnsWithValues<R, K extends string>(rows: readonly R[], cells: Record<K, (row: R) => unknown>): Set<K> {
  const keys = Object.keys(cells) as K[]
  return new Set(
    keys.filter((key) =>
      rows.some((row) => {
        const value = cells[key](row)
        return value !== null && value !== undefined && value !== ''
      }),
    ),
  )
}
