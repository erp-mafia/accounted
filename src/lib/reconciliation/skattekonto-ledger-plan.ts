import { roundOre } from '@/lib/money'

/**
 * Which open Skatteverket rows does which open verifikat on 1630 hold,
 * exactly to the öre? The link plan behind the reconciliation's ledger
 * proposals (PH 171).
 *
 * A previous system often books the skattekonto as one verifikat per month
 * (or quarter, or year): every charge and interest row of the statement in
 * one voucher. Skatteverket reports each event as its own row, so after an
 * import none of them has a verifikat of its own and the single-row and
 * same-day matchers find nothing (the interest row sits a week before the
 * draw, a month holds five rows). The cover test (findLedgerCoverPoint)
 * already knows the rows are in the ledger; this says which verifikat holds
 * which rows, so they can be linked in one action instead of one group at a
 * time.
 *
 * Arithmetic only, in two steps.
 *
 * 1. Segments. Walk the open rows and open verifikat in date order and keep
 *    the running gap (verifikat minus rows, in öre) after each date. When the
 *    gap returns to a value it had at an earlier date, everything still
 *    unassigned in between sums to exactly zero. A segment closes as soon as
 *    it can (the nearest earlier date with the same gap) and is taken out, so
 *    a pair that spans an inner one (moms booked on the period end, posted by
 *    Skatteverket six weeks later) still closes around it. Rows that cancel
 *    each other with no verifikat between them (a payment in and the charges
 *    it paid, both booked outside 1630) close on their own and are never
 *    proposed; verifikat that cancel each other alone likewise.
 * 2. Within a segment: verifikat that cancel each other exactly (an
 *    annulment pair the previous system booked) are set aside. One verifikat
 *    left: it holds every row. Several: the rows in date order must split, at
 *    a change of date, into consecutive runs that equal the verifikat in date
 *    order (a summary dated after the next month's interest row, say), each
 *    cut at the only date where it fits.
 *
 * A run is proposed only when no part of its rows nets to zero: such a part
 * moves nothing on 1630, so the verifikat is explained without it and the
 * rows are not what it holds (the crm#1004 rule of the combined matcher: an
 * inbetalning and the charges it paid next to the interest a one-line
 * verifikat really carries). Anything that is a choice rather than
 * arithmetic (two verifikat on one date, a cut that fits at two dates, a part
 * that nets to zero, a dead link, more than MAX_PLAN_ROWS_PER_ENTRY rows) is
 * left to Matcha manuellt. A constant offset (an ignored row, a row really
 * missing from the ledger, the part of a year-end verifikat from before the
 * fetched history) shifts the gap for good and leaves the segment around it
 * unproposed, while the segments after it still close. Each proposal is an
 * exact N:1 link, the shape linkSkattekontoRows accepts without
 * allow_remainder.
 */

/** The N:1 link's own cap (linkSkattekontoRows, matchPairs). */
export const MAX_PLAN_ROWS_PER_ENTRY = 50

/** Subset sums kept while looking for a part that nets to zero; past it the run is not proposed. */
const MAX_SUBSET_SUMS = 100_000

export interface LedgerPlanRow {
  id: string
  date: string
  /** Skatteverket sign: positive into the skattekonto. */
  amount: number
  /** False for a row that cannot be linked as it is (a dead link to a reversed or draft verifikat). */
  linkable: boolean
}

export interface LedgerPlanEntry {
  id: string
  date: string
  /** What no row explains of the verifikat on 1630 (its net, or its remainder), ledger sign. */
  amount: number
  /** False for a verifikat a link refuses (reversed). */
  linkable: boolean
}

export interface PlannedLedgerLink {
  journal_entry_id: string
  /** The rows the verifikat holds, in date order. */
  event_ids: string[]
  /** Their sum, Skatteverket sign: equal to the verifikat's open amount. */
  total: number
  /** The earliest and latest date among the rows and the verifikat. */
  from_date: string
  to_date: string
}

interface Item {
  kind: 'row' | 'entry'
  id: string
  date: string
  ore: number
  linkable: boolean
}

const toOre = (n: number) => Math.round(n * 100)

function byDateThenId(a: Item, b: Item): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Does a non-empty part of these amounts, short of all of them, sum to zero?
 * The whole run sums to its verifikat, never zero, so any zero sum found is
 * such a part. Null when the search grew past MAX_SUBSET_SUMS: unknown.
 */
function hasZeroSumPart(ores: number[]): boolean | null {
  const sums = new Set<number>()
  for (const value of ores) {
    if (value === 0) return true
    const next = [value]
    for (const s of sums) next.push(s + value)
    for (const s of next) {
      if (s === 0) return true
      sums.add(s)
    }
    if (sums.size > MAX_SUBSET_SUMS) return null
  }
  return false
}

/**
 * The verifikat of a segment without those that cancel each other: for an
 * amount v, as many of +v as of -v are set aside. Null when they do not
 * pair up evenly (which of two equal verifikat is the real one is a choice).
 */
function withoutCancelling(entries: Item[]): Item[] | null {
  const byOre = new Map<number, Item[]>()
  for (const e of entries) byOre.set(e.ore, [...(byOre.get(e.ore) ?? []), e])
  const kept: Item[] = []
  for (const [value, list] of byOre) {
    const opposite = byOre.get(-value)
    if (!opposite) {
      kept.push(...list)
      continue
    }
    if (opposite.length !== list.length) return null
  }
  return kept.sort(byDateThenId)
}

function link(entry: Item, rows: Item[]): PlannedLedgerLink {
  const dates = [entry.date, ...rows.map((r) => r.date)].sort()
  return {
    journal_entry_id: entry.id,
    event_ids: rows.map((r) => r.id),
    total: roundOre(rows.reduce((sum, r) => sum + r.ore, 0) / 100),
    from_date: dates[0],
    to_date: dates[dates.length - 1],
  }
}

/** The links one closed segment proposes; empty when arithmetic alone cannot split it. */
function linksOf(segment: Item[]): PlannedLedgerLink[] {
  const rows = segment.filter((i) => i.kind === 'row')
  if (rows.length === 0 || rows.some((r) => !r.linkable)) return []
  const entries = withoutCancelling(segment.filter((i) => i.kind === 'entry'))
  if (!entries || entries.length === 0 || entries.some((e) => !e.linkable)) return []
  if (new Set(entries.map((e) => e.date)).size !== entries.length) return []

  // The running sum of the rows at every change of date: position (rows
  // taken so far) and sum. Each cut between two verifikat must fit at
  // exactly one of them.
  const cuts: Array<{ position: number; sum: number }> = []
  let sum = 0
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].ore
    if (i === rows.length - 1 || rows[i + 1].date !== rows[i].date) cuts.push({ position: i + 1, sum })
  }
  const links: PlannedLedgerLink[] = []
  let from = 0
  let target = 0
  for (let j = 0; j < entries.length; j++) {
    target += entries[j].ore
    const fits = j === entries.length - 1 ? [cuts[cuts.length - 1]] : cuts.filter((c) => c.sum === target)
    if (fits.length !== 1 || fits[0].sum !== target || fits[0].position <= from) return []
    const run = rows.slice(from, fits[0].position)
    if (run.length > MAX_PLAN_ROWS_PER_ENTRY || hasZeroSumPart(run.map((r) => r.ore)) !== false) return []
    links.push(link(entries[j], run))
    from = fits[0].position
  }
  return links
}

export function planSkattekontoLedgerLinks(input: {
  rows: LedgerPlanRow[]
  entries: LedgerPlanEntry[]
}): PlannedLedgerLink[] {
  const items: Item[] = [
    ...input.rows.map((r) => ({ kind: 'row' as const, id: r.id, date: r.date, ore: toOre(r.amount), linkable: r.linkable })),
    ...input.entries.map((e) => ({ kind: 'entry' as const, id: e.id, date: e.date, ore: toOre(e.amount), linkable: e.linkable })),
  ]
    // A zero amount moves nothing and settles nothing.
    .filter((i) => i.ore !== 0)
    .sort(byDateThenId)

  const planned: PlannedLedgerLink[] = []
  // Unassigned items in date order, and for each gap value the length of
  // `pending` at the latest date it was seen (only dates still open count).
  const pending: Item[] = []
  const marks = new Map<number, number>([[0, 0]])
  let gap = 0
  let i = 0
  while (i < items.length) {
    const date = items[i].date
    while (i < items.length && items[i].date === date) {
      const item = items[i]
      pending.push(item)
      gap += item.kind === 'entry' ? item.ore : -item.ore
      i++
    }
    const start = marks.get(gap)
    if (start === undefined) {
      marks.set(gap, pending.length)
      continue
    }
    // Closed whether or not it is proposed: an exact segment that cannot be
    // split by arithmetic (rows or verifikat that only cancel each other
    // included) stays out of every larger one.
    planned.push(...linksOf(pending.slice(start)))
    pending.length = start
    for (const [value, position] of marks) {
      if (position > start) marks.delete(value)
    }
  }
  return planned
}
