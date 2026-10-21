/**
 * One bank row that settles several open invoices of ONE counterparty: two
 * supplier invoices from the same supplier paid with one internet-bank
 * payment (PH 192), or a customer paying two of its invoices in one transfer.
 *
 * The 1:1 matchers (lib/invoices/invoice-matching.ts,
 * lib/invoices/supplier-invoice-matching.ts) stay silent on such a row: no
 * single invoice has its amount. The candidate here is the exact subset:
 * 2..COMBINATION_MAX_SIZE open invoices of one counterparty whose remainders
 * add up to the row to the öre, each with the row's date inside its payment
 * window. It is proposed only when it is the ONLY explanation of that shape:
 *
 *   - a single open invoice with the row's amount means the row is the 1:1
 *     path's (or nobody's), never a set;
 *   - a second subset (same counterparty or another one, any size) that also
 *     fits makes the amount ambiguous, and nothing is proposed;
 *   - a counterparty with more than COMBINATION_MAX_CANDIDATES eligible
 *     invoices makes a chance sum too likely, and a search past
 *     COMBINATION_NODE_BUDGET steps cannot rule a second set out, so
 *     nothing is proposed either;
 *   - two bank rows whose sets share an invoice cancel each other out
 *     (matchRowsToInvoiceCombinations): the amount cannot say which row paid.
 *
 * Measured in production before shipping (2026-10-21, bank rows of the last
 * 90 days that have been booked): 11 had such a unique set when they were
 * booked; 9 were booked as exactly that set through the batch match, and the
 * other 2 settled the same amount by hand. None went to other invoices. The
 * refusals above are what keeps it there; widening them is a precision
 * decision, not a tuning knob.
 *
 * SEK only: the allocation the dialog books is in the row's currency, and a
 * remainder in another currency has no stored rate that makes it comparable
 * here (same refusal as the ROT/RUT set).
 *
 * Pure and client-safe on purpose: the worklist computes it at read time over
 * the open pool (no hint column, so nothing goes stale when an invoice is
 * settled elsewhere, #1259), and its tests need no database.
 */

import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { addDaysIso } from '@/lib/dates/iso'

/** Largest set proposed. Every one-counterparty multi-invoice booking in production had 2 or 3. */
export const COMBINATION_MAX_SIZE = 4

/**
 * Eligible invoices per counterparty above which nothing is proposed. Every
 * true case measured had at most 3; with more, the number of subsets grows
 * fast and a sum of whole-krona invoices that happens to equal an unrelated
 * row becomes likely (25 eligible already make 15 000 sets of 2 to 4).
 */
export const COMBINATION_MAX_CANDIDATES = 8

/** Search steps per bank row before the answer counts as undecidable. */
export const COMBINATION_NODE_BUDGET = 20_000

/** Days before the invoice date a payment may fall (a payment booked the day before the invoice is dated). */
const DAYS_BEFORE_INVOICE = 5
/**
 * Days after the due date a payment may fall. Wider than the 1:1 amount+date
 * pass (5 days): two invoices paid together are often two late ones.
 */
const DAYS_AFTER_DUE = 45
/** Window ends assumed when one of the two dates is missing (typical 30-day terms). */
const ASSUMED_TERMS_DAYS = 30

export interface CombinationInvoice {
  id: string
  /** customer_id or supplier_id: a set never mixes counterparties. Null never takes part. */
  counterpartyId: string | null
  /** What the invoice still owes, in its own currency. */
  remaining: number
  currency?: string | null
  invoiceDate: string | null
  dueDate: string | null
}

export interface CombinationRow {
  id: string
  /** Signed: negative pays supplier invoices, positive receives customer invoices. */
  amount: number
  currency?: string | null
  /** YYYY-MM-DD */
  date: string
}

export interface InvoiceCombination<T extends CombinationInvoice> {
  counterpartyId: string
  /** The invoices the row settles, oldest due date first (the order the batch dialog lists them). */
  invoices: T[]
  /** Their remainders together: equals the row to the öre. */
  total: number
}

export interface InvoiceCombinationOptions {
  maxSize?: number
  maxCandidates?: number
  nodeBudget?: number
}

function toOre(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * Whether a payment dated `rowDate` can be the one that settles the invoice:
 * from five days before its invoice date to 45 days after its due date. An
 * invoice with neither date never takes part.
 */
export function inCombinationWindow(
  rowDate: string,
  invoice: Pick<CombinationInvoice, 'invoiceDate' | 'dueDate'>,
): boolean {
  const { invoiceDate, dueDate } = invoice
  if (!invoiceDate && !dueDate) return false
  const start = invoiceDate
    ? addDaysIso(invoiceDate, -DAYS_BEFORE_INVOICE)
    : addDaysIso(dueDate as string, -(ASSUMED_TERMS_DAYS + DAYS_BEFORE_INVOICE))
  const end = dueDate
    ? addDaysIso(dueDate, DAYS_AFTER_DUE)
    : addDaysIso(invoiceDate as string, ASSUMED_TERMS_DAYS + DAYS_AFTER_DUE)
  return rowDate >= start && rowDate <= end
}

interface Entry<T> {
  invoice: T
  ore: number
}

function byDueDate<T extends CombinationInvoice>(a: T, b: T): number {
  const da = a.dueDate ?? '9999-12-31'
  const db = b.dueDate ?? '9999-12-31'
  if (da !== db) return da < db ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The one set of 2..maxSize open invoices of one counterparty that adds up to
 * the bank row, or null (none, a single invoice fits, more than one set
 * fits, or the search could not rule a second set out). The caller passes the
 * pool of the row's direction: supplier invoices for a payment, customer
 * invoices for a receipt.
 */
export function findInvoiceCombination<T extends CombinationInvoice>(
  row: CombinationRow,
  invoices: readonly T[],
  options: InvoiceCombinationOptions = {},
): InvoiceCombination<T> | null {
  const maxSize = Math.max(2, options.maxSize ?? COMBINATION_MAX_SIZE)
  const maxCandidates = Math.max(2, options.maxCandidates ?? COMBINATION_MAX_CANDIDATES)
  const budget = Math.max(1, options.nodeBudget ?? COMBINATION_NODE_BUDGET)
  if (!isLedgerCurrency(row.currency)) return null
  const target = toOre(Math.abs(row.amount))
  if (!(target > 0)) return null

  const groups = new Map<string, Entry<T>[]>()
  for (const invoice of invoices) {
    if (!invoice.counterpartyId || !isLedgerCurrency(invoice.currency)) continue
    const ore = toOre(invoice.remaining)
    if (!(ore > 0) || ore > target) continue
    if (!inCombinationWindow(row.date, invoice)) continue
    // One invoice explains the row on its own: the 1:1 matcher's row (or an
    // ambiguous one), never a set.
    if (ore === target) return null
    const group = groups.get(invoice.counterpartyId)
    if (group) group.push({ invoice, ore })
    else groups.set(invoice.counterpartyId, [{ invoice, ore }])
  }

  let solution: { counterpartyId: string; entries: Entry<T>[] } | null = null
  let solutions = 0
  let nodes = 0
  let undecidable = false

  for (const [counterpartyId, group] of groups) {
    if (group.length < 2) continue
    // Largest first, so the suffix sums prune whole branches.
    const sorted = [...group].sort((a, b) => b.ore - a.ore || (a.invoice.id < b.invoice.id ? -1 : 1))
    const suffix = new Array<number>(sorted.length + 1).fill(0)
    for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sorted[i].ore
    // Together they owe less than the row: no set here, however many.
    if (suffix[0] < target) continue
    // Too many: a sum that fits by chance gets likely, and every true case
    // measured had at most three.
    if (group.length > maxCandidates) return null

    const chosen: number[] = []
    // Returns true to stop the whole search: a second solution, or the budget.
    const walk = (start: number, remaining: number): boolean => {
      for (let i = start; i < sorted.length; i++) {
        if (++nodes > budget) {
          undecidable = true
          return true
        }
        const ore = sorted[i].ore
        // Even everything from here on cannot reach what is left.
        if (suffix[i] < remaining) return false
        // Nor can the slots left, each at most this (largest remaining) amount.
        if ((maxSize - chosen.length) * ore < remaining) return false
        if (ore > remaining) continue
        chosen.push(i)
        if (ore === remaining) {
          if (chosen.length >= 2) {
            solutions++
            if (solutions > 1) return true
            solution = { counterpartyId, entries: chosen.map((index) => sorted[index]) }
          }
        } else if (chosen.length < maxSize && walk(i + 1, remaining - ore)) {
          return true
        }
        chosen.pop()
      }
      return false
    }

    if (walk(0, target)) break
  }

  if (undecidable || solutions !== 1 || !solution) return null
  const found = solution as { counterpartyId: string; entries: Entry<T>[] }
  const members = found.entries.map((entry) => entry.invoice).sort(byDueDate)
  return {
    counterpartyId: found.counterpartyId,
    invoices: members,
    total: found.entries.reduce((sum, entry) => sum + entry.ore, 0) / 100,
  }
}

/**
 * Pair bank rows with the invoice set each one settles: payments against the
 * supplier pool, receipts against the customer pool. A set that two rows both
 * claim (an invoice in each) is proposed for neither: the amount alone cannot
 * say which row paid it, and a duplicate import looks exactly like that.
 * The caller passes only rows that are still unbooked and carry no other
 * suggestion, and leaves out of the pools the invoices another suggestion is
 * about to settle.
 */
export function matchRowsToInvoiceCombinations<C extends CombinationInvoice, S extends CombinationInvoice>(
  rows: readonly CombinationRow[],
  pools: { customer: readonly C[]; supplier: readonly S[] },
  options: InvoiceCombinationOptions = {},
): Map<string, InvoiceCombination<C> | InvoiceCombination<S>> {
  const out = new Map<string, InvoiceCombination<C> | InvoiceCombination<S>>()
  const claims = new Map<string, string[]>()
  for (const row of rows) {
    const match =
      row.amount > 0
        ? findInvoiceCombination(row, pools.customer, options)
        : row.amount < 0
          ? findInvoiceCombination(row, pools.supplier, options)
          : null
    if (!match) continue
    out.set(row.id, match)
    for (const invoice of match.invoices) {
      const claimants = claims.get(invoice.id)
      if (claimants) claimants.push(row.id)
      else claims.set(invoice.id, [row.id])
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length > 1) for (const rowId of claimants) out.delete(rowId)
  }
  return out
}
