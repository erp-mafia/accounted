/**
 * The verifikat a booking door answered with, whichever door it was.
 *
 * JournalEntryForm posts to several doors, and they do not answer alike:
 *   - POST /api/bookkeeping/journal-entries: { data: entry };
 *   - POST /api/transactions/:id/book and /api/webshop-orders/:id/book:
 *     { data: entry, journal_entry_id };
 *   - POST /api/extensions/ext/invoice-inbox/items/:id/book-direct:
 *     { data: { journal_entry: entry, inbox_item_id, transaction_id } }.
 * Reading only the first two shapes lost the book-direct verifikat: the form
 * never said the entry was created, so the Inkorg never moved on and the
 * receipt that came with the invoice never followed it. Pure: no I/O.
 */

/** The verifikat as far as the form reads it: its id and its voucher label. */
export interface BookedEntry {
  id: string | null
  voucher_series?: string | null
  voucher_number?: number | null
  /**
   * Whether the door archived its own generated underlag on the verifikat
   * (POST /api/webshop-orders/:id/book answers it, top level). Absent when
   * the door does not say.
   */
  underlag_archived?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryFields(value: Record<string, unknown>): Omit<BookedEntry, 'id'> {
  return {
    ...(typeof value.voucher_series === 'string' ? { voucher_series: value.voucher_series } : {}),
    ...(typeof value.voucher_number === 'number' ? { voucher_number: value.voucher_number } : {}),
  }
}

/** The entry a booking answer names, or `{ id: null }` when it names none. */
export function bookedEntryOf(answer: unknown): BookedEntry {
  if (!isRecord(answer)) return { id: null }
  const underlag =
    typeof answer.underlag_archived === 'boolean' ? { underlag_archived: answer.underlag_archived } : {}
  const data = isRecord(answer.data) ? answer.data : null
  // book-direct: the entry is nested under data.journal_entry.
  const nested = data && isRecord(data.journal_entry) ? data.journal_entry : null
  if (nested && typeof nested.id === 'string') return { id: nested.id, ...entryFields(nested), ...underlag }
  if (data && typeof data.id === 'string') return { id: data.id, ...entryFields(data), ...underlag }
  const top = typeof answer.journal_entry_id === 'string' ? answer.journal_entry_id : null
  return { id: top, ...(data ? entryFields(data) : {}), ...underlag }
}
