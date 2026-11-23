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

import { formatRowAmount } from '@/lib/utils'
import type { InboxDocumentKind } from '@/lib/documents/inbox-kind'
import type { BookingScreenSubject } from './booking-screen'

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

/** Where the next page of open bank rows starts, as the route answers it. */
export interface ToBookBankCursor {
  after_date: string
  after_id: string
}

/** One page of GET /api/transactions?unmatched=true. */
export interface ToBookBankPage {
  data?: ToBookBankRow[]
  has_more?: boolean
  next?: ToBookBankCursor | null
}

/**
 * Every open bank row. The route answers at most 500 rows a request and says
 * has_more when more follow, so the rows are read page after page, each from
 * where the one before ended, until none are left: the list and its counts
 * then hold every open row, not the newest 500. A page that fails fails the
 * read, and so does an answer that has more but no next that moves on (it
 * would read the same page again): a partial list is never shown as the whole.
 */
export async function readAllToBookBankRows(
  readPage: (after: ToBookBankCursor | null) => Promise<ToBookBankPage>,
): Promise<ToBookBankRow[]> {
  const rows: ToBookBankRow[] = []
  let after: ToBookBankCursor | null = null
  for (;;) {
    const page = await readPage(after)
    if (!page.has_more) return [...rows, ...(page.data ?? [])]
    const next = page.next
    if (!next || (next.after_date === after?.after_date && next.after_id === after.after_id)) {
      throw new Error('The open bank rows answer has more rows but no next page to read')
    }
    rows.push(...(page.data ?? []))
    after = next
  }
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
  /** What the document is (resolveInboxKind), null while unknown. */
  kind: InboxDocumentKind | null
}

/**
 * An open skattekonto event (lib/skatteverket/skattekonto-open-rows.ts), as
 * the skattekonto read answers it: Skatteverket carried it out and no
 * verifikat holds it yet.
 */
export interface ToBookSkattekontoRow {
  id: string
  /** transaktionsdatum */
  date: string
  /** transaktionstext */
  text: string
  /** belopp_skatteverket: positive is money into the skattekonto. */
  amount: number
}

/**
 * What the row has for underlag: a document on the bank row, one found for
 * it in Inkommande, none yet, the row is itself a document, or Skatteverket's
 * own record of a skattekonto event.
 */
export type ToBookUnderlag = 'attached' | 'found' | 'missing' | 'document' | 'skatteverket'

export interface ToBookRow {
  key: string
  kind: 'bank' | 'document' | 'skattekonto'
  /** The bank row, for a bank row. */
  transactionId: string | null
  /** The skattekonto event, for a skattekonto row. */
  skattekontoId: string | null
  /** The inbox item: the document itself, or the one found for the bank row. */
  inboxItemId: string | null
  date: string | null
  name: string
  amount: number | null
  currency: string | null
  cashAccountId: string | null
  underlag: ToBookUnderlag
  /** What the document found for the bank row is, when one was found. */
  foundKind: InboxDocumentKind | null
}

export const TO_BOOK_FILTERS = ['all', 'missing', 'found', 'no_bank', 'skattekonto'] as const
export type ToBookFilter = (typeof TO_BOOK_FILTERS)[number]

/** Newest first; rows without a date last, in the order they came. */
function newestFirst(a: ToBookRow, b: ToBookRow): number {
  if (a.date === b.date) return 0
  if (!a.date) return 1
  if (!b.date) return -1
  return a.date < b.date ? 1 : -1
}

export function buildToBookRows(
  bankRows: readonly ToBookBankRow[],
  documents: readonly ToBookDocument[],
  skattekonto: readonly ToBookSkattekontoRow[] = [],
): ToBookRow[] {
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
      skattekontoId: null,
      inboxItemId: found?.id ?? null,
      date: r.date,
      name: r.description,
      amount: r.amount,
      currency: r.currency,
      cashAccountId: r.cash_account_id,
      underlag: r.document_id ? 'attached' : found ? 'found' : 'missing',
      foundKind: found?.kind ?? null,
    }
  })
  const docs: ToBookRow[] = documents
    .filter((d) => !shownOnRow.has(d.id))
    .map((d) => ({
      key: `doc:${d.id}`,
      kind: 'document',
      transactionId: null,
      skattekontoId: null,
      inboxItemId: d.id,
      date: d.date,
      name: d.name,
      amount: d.amount,
      currency: d.currency,
      cashAccountId: null,
      underlag: 'document',
      foundKind: null,
    }))
  const skv: ToBookRow[] = skattekonto.map((r) => ({
    key: `skv:${r.id}`,
    kind: 'skattekonto',
    transactionId: null,
    skattekontoId: r.id,
    inboxItemId: null,
    date: r.date,
    name: r.text,
    amount: r.amount,
    currency: 'SEK',
    cashAccountId: null,
    underlag: 'skatteverket',
    foundKind: null,
  }))
  return [...bank, ...docs, ...skv].sort(newestFirst)
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
    case 'skattekonto':
      return row.kind === 'skattekonto'
  }
}

/** How many rows each filter holds. */
export function toBookCounts(rows: readonly ToBookRow[]): Record<ToBookFilter, number> {
  return Object.fromEntries(TO_BOOK_FILTERS.map((f) => [f, rows.filter((r) => inToBookFilter(r, f)).length])) as Record<
    ToBookFilter,
    number
  >
}

/**
 * A row's amount as the list and the booking screen write it: money in on a
 * bank row or the skattekonto carries a "+" (it shows green beside it), a
 * document's amount has no sign of its own, no amount is no text.
 */
export function toBookAmountLabel(row: Pick<ToBookRow, 'kind' | 'amount' | 'currency'>): string {
  if (row.amount == null) return ''
  return `${toBookIsMoneyIn(row) ? '+' : ''}${formatRowAmount(row.amount, row.currency)}`
}

/** Money in on a bank row or the skattekonto: the list shows its amount green. */
export function toBookIsMoneyIn(row: Pick<ToBookRow, 'kind' | 'amount'>): boolean {
  return row.kind !== 'document' && row.amount != null && row.amount > 0
}

/** The list's page. */
export const TO_BOOK_PATH = '/att-bokfora'

/**
 * Where a "book these" link leads (Hem's and Behöver dig's row, Börja, ⌘K,
 * onboarding): Att bokföra where the booking screen is switched on, else the
 * page the link led to before it.
 */
export function toBookDoor(bookingScreen: boolean, before: string): string {
  return bookingScreen ? TO_BOOK_PATH : before
}

/**
 * Whether a row opens on the booking screen: a bank row, with the receipt
 * found for it if one was (the screen holds it as the row's underlag). A
 * bank row with another kind of document found for it (an invoice, which may
 * belong in leverantörsreskontran) and a document without a bank row open in
 * Inkommande, where those are decided.
 */
export function opensInBookingScreen(row: ToBookRow): boolean {
  if (row.kind !== 'bank' || row.transactionId === null) return false
  return row.underlag !== 'found' || (row.foundKind === 'receipt' && row.inboxItemId !== null)
}

/** What the booking screen books for a row that opens there: its bank row, with the receipt found for it. */
export function toBookScreenSubject(row: ToBookRow): BookingScreenSubject {
  return {
    kind: 'transaction',
    transactionId: row.transactionId as string,
    account: null,
    ...(row.underlag === 'found' && row.inboxItemId ? { foundItemId: row.inboxItemId } : {}),
  }
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
  skattekonto: 'skattekonto',
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
