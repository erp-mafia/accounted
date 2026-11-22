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
