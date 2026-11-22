/**
 * Att bokföra: one list of what waits to be booked, built from two reads the
 * product already makes. The open bank rows (open_bank_rows, through GET
 * /api/transactions?unmatched=true) and the documents Inkommande asks a
 * person about (its own read and its Behöver dig queue).
 *
 * A document that looks paid by one of the open bank rows (its bank_match)
 * is shown on that row as "found" instead of as a row of its own, so one
 * purchase is one row. A bank row that already holds a document keeps it,
 * and a document matched to it elsewhere stays a row of its own: nothing is
 * hidden. Pure, so the page and the tests read the same rows.
 */

/** An open bank row, as GET /api/transactions?unmatched=true answers it. */
export interface ToBookBankRow {
  id: string
  date: string
  description: string
  amount: number
  currency: string | null
  cash_account_id: string | null
  /** The document pinned to the row, if any. */
  document_id: string | null
}

/** A document waiting in Inkommande. */
export interface ToBookDocument {
  id: string
  name: string
  /** The document's own date when read, else the day it arrived. */
  date: string | null
  amount: number | null
  currency: string | null
  /** The open bank row it looks paid by, if any (Inkommande's bank_match). */
  bankMatchTransactionId: string | null
}

/**
 * What the row has for underlag: a document on the bank row, one found for
 * it in Inkommande, none yet, or the row is itself a document.
 */
export type ToBookUnderlag = 'attached' | 'found' | 'missing' | 'document'

export interface ToBookRow {
  key: string
  kind: 'bank' | 'document'
  /** The bank row, for a bank row. */
  transactionId: string | null
  /** The inbox item: the document itself, or the one found for the bank row. */
  inboxItemId: string | null
  date: string | null
  name: string
  amount: number | null
  currency: string | null
  cashAccountId: string | null
  underlag: ToBookUnderlag
}

export const TO_BOOK_FILTERS = ['all', 'missing', 'found', 'no_bank'] as const
export type ToBookFilter = (typeof TO_BOOK_FILTERS)[number]

/** Newest first; rows without a date last, in the order they came. */
function newestFirst(a: ToBookRow, b: ToBookRow): number {
  if (a.date === b.date) return 0
  if (!a.date) return 1
  if (!b.date) return -1
  return a.date < b.date ? 1 : -1
}

export function buildToBookRows(bankRows: readonly ToBookBankRow[], documents: readonly ToBookDocument[]): ToBookRow[] {
  // A row without a document gets the first document that looks paid by it.
  const waiting = new Set(bankRows.filter((r) => !r.document_id).map((r) => r.id))
  const foundFor = new Map<string, ToBookDocument>()
  for (const doc of documents) {
    const tx = doc.bankMatchTransactionId
    if (tx && waiting.has(tx) && !foundFor.has(tx)) foundFor.set(tx, doc)
  }
  const shownOnRow = new Set([...foundFor.values()].map((d) => d.id))

  const bank: ToBookRow[] = bankRows.map((r) => {
    const found = foundFor.get(r.id) ?? null
    return {
      key: `tx:${r.id}`,
      kind: 'bank',
      transactionId: r.id,
      inboxItemId: found?.id ?? null,
      date: r.date,
      name: r.description,
      amount: r.amount,
      currency: r.currency,
      cashAccountId: r.cash_account_id,
      underlag: r.document_id ? 'attached' : found ? 'found' : 'missing',
    }
  })
  const docs: ToBookRow[] = documents
    .filter((d) => !shownOnRow.has(d.id))
    .map((d) => ({
      key: `doc:${d.id}`,
      kind: 'document',
      transactionId: null,
      inboxItemId: d.id,
      date: d.date,
      name: d.name,
      amount: d.amount,
      currency: d.currency,
      cashAccountId: null,
      underlag: 'document',
    }))
  return [...bank, ...docs].sort(newestFirst)
}

/** Whether a row belongs under a filter. */
export function inToBookFilter(row: ToBookRow, filter: ToBookFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'missing':
      return row.underlag === 'missing'
    case 'found':
      return row.underlag === 'found'
    case 'no_bank':
      return row.kind === 'document'
  }
}

/** How many rows each filter holds. */
export function toBookCounts(rows: readonly ToBookRow[]): Record<ToBookFilter, number> {
  return Object.fromEntries(TO_BOOK_FILTERS.map((f) => [f, rows.filter((r) => inToBookFilter(r, f)).length])) as Record<
    ToBookFilter,
    number
  >
}

/** The list's page. */
export const TO_BOOK_PATH = '/att-bokfora'

/**
 * Whether a row opens on the booking screen: a bank row without a document
 * found for it. A found pair and a document open in Inkommande, where the
 * pair is confirmed or the document is booked.
 */
export function opensInBookingScreen(row: ToBookRow): boolean {
  return row.kind === 'bank' && row.underlag !== 'found' && row.transactionId !== null
}

/**
 * The bank rows the booking screen steps through (J, K, and the next row
 * after Bokför): the list's rows under its filter, in its order, that open
 * there.
 */
export function bookingWalk(rows: readonly ToBookRow[], filter: ToBookFilter): string[] {
  return rows.filter((r) => inToBookFilter(r, filter) && opensInBookingScreen(r)).map((r) => r.transactionId as string)
}

/** The list's filter in its address (?visa=), so the way back and the walk keep it. Alla has none. */
export const TO_BOOK_FILTER_PARAM = 'visa'
const FILTER_SLUGS: Record<Exclude<ToBookFilter, 'all'>, string> = {
  missing: 'saknar-underlag',
  found: 'kvitto-hittat',
  no_bank: 'utan-bankrad',
}

/** The filter an address names; an unknown or missing one is Alla. */
export function toBookFilterFromSlug(slug: string | null | undefined): ToBookFilter {
  const hit = (Object.keys(FILTER_SLUGS) as Exclude<ToBookFilter, 'all'>[]).find((f) => FILTER_SLUGS[f] === slug)
  return hit ?? 'all'
}

/** The list's address under a filter. */
export function toBookListHref(filter: ToBookFilter): string {
  return filter === 'all' ? TO_BOOK_PATH : `${TO_BOOK_PATH}?${TO_BOOK_FILTER_PARAM}=${FILTER_SLUGS[filter]}`
}

/**
 * The filter a return address to the list carries, or null when the address
 * is not the list: the booking screen then has no rows to step through.
 */
export function toBookFilterOfBack(back: string | null): ToBookFilter | null {
  if (!back) return null
  const at = back.indexOf('?')
  const path = at === -1 ? back : back.slice(0, at)
  if (path !== TO_BOOK_PATH) return null
  return toBookFilterFromSlug(new URLSearchParams(at === -1 ? '' : back.slice(at + 1)).get(TO_BOOK_FILTER_PARAM))
}
