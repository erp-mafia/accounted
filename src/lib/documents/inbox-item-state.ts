/**
 * Where an inbox item stands, and whether it is still open: the one reading.
 *
 * Pure: no client, no I/O, no React. It takes a wire row or a table row alike,
 * so the Inkorg, the Underlag workspace, MCP, v1, the counts and the doors
 * that refuse a second booking all answer the same. It sits with the documents
 * because the ledger's own doors read it and a kernel imports no block
 * (lib/modules/README.md); the Inkorg page's view of an item is
 * lib/inkorg/items.ts.
 */

/**
 * Where an item stands:
 *   - booked: it became a supplier invoice or a verifikat, its matched
 *     transaction is booked with this item's underlag on the verifikat, or,
 *     matched to nothing, a verifikat holds its document;
 *   - processing: the reading has not landed yet (seconds);
 *   - linked: matched to a bank transaction that still needs booking, or
 *     whose verifikat does not carry this underlag (a person decides);
 *   - error: the reading failed;
 *   - needs_action: everything else, waiting for its first decision.
 *
 * Every page, list and count reads an item through this module, so an item
 * never stands differently on two of them.
 */
export type InkorgStage = 'needs_action' | 'processing' | 'linked' | 'booked' | 'error'

/** A booked matched transaction whose verifikat does not carry this item's underlag. */
export function isUnderlagDivergent(item: { matched_transaction_journal_entry_id?: string | null; underlag_status?: string | null }): boolean {
  return !!item.matched_transaction_journal_entry_id && !!item.underlag_status && item.underlag_status !== 'anchored'
}

/** The columns an item's stage is read from: a wire row, or the table row a server door reads. */
export interface StageFields {
  status?: string | null
  matched_transaction_id?: string | null
  created_supplier_invoice_id?: string | null
  created_journal_entry_id?: string | null
  matched_transaction_journal_entry_id?: string | null
  underlag_status?: string | null
  document_journal_entry_id?: string | null
  routed_to_arkiv_at?: string | null
}

export function itemStage(item: StageFields): InkorgStage {
  if (item.created_supplier_invoice_id || item.created_journal_entry_id) return 'booked'
  if (item.matched_transaction_journal_entry_id && !isUnderlagDivergent(item)) return 'booked'
  // Matched to a row, its document elsewhere is the mismatch a person decides on, so that stays 'linked'.
  if (item.document_journal_entry_id && !item.matched_transaction_id) return 'booked'
  if (item.status === 'processing') return 'processing'
  if (item.matched_transaction_id) return 'linked'
  if (item.status === 'error') return 'error'
  return 'needs_action'
}

/**
 * Something holds the item: a supplier invoice, a verifikat, a bank row, or a
 * verifikat its document sits on. The one reading of "consumed" behind the
 * open reading below; nothing but a storno or an unlink gives the item back.
 */
export function isInboxItemTaken(item: StageFields): boolean {
  return !!item.matched_transaction_id || itemStage(item) === 'booked'
}

/**
 * Still waiting in the inbox for its first decision: nothing holds it and
 * Arkiv did not take it. What the lists call unprocessed, what the counts
 * count, what a proposal or an agent may offer. Rows read without their
 * document (INBOX_ITEM_DOCUMENT_HOLD) answer from their own columns.
 */
export function isOpenInboxItem(item: StageFields): boolean {
  return !item.routed_to_arkiv_at && !isInboxItemTaken(item)
}

/** Nothing books it yet, a bank row it is matched to included: it can still follow its other half, or be booked. */
export function isInboxItemUnbooked(item: StageFields): boolean {
  return !item.routed_to_arkiv_at && itemStage(item) !== 'booked'
}

/** The one filter method the two readings below use, on any query of the table. */
interface IsFilter {
  is(column: string, value: null): IsFilter
}

/** isInboxItemTaken as a filter on the item's own columns: reads and guarded writes both. */
export function whereInboxItemFree<Query>(query: Query): Query {
  return (query as unknown as IsFilter)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null) as unknown as Query
}

/** isOpenInboxItem as a filter on the item's own columns. A read of the document finishes it. */
export function whereInboxItemOpen<Query>(query: Query): Query {
  return (whereInboxItemFree(query) as unknown as IsFilter).is('routed_to_arkiv_at', null) as unknown as Query
}

/** Selected with an item: its document, and the status of the verifikat that holds it. */
export const INBOX_ITEM_DOCUMENT_HOLD =
  'document_hold:document_attachments(journal_entry_id, entry:journal_entries!document_attachments_journal_entry_id_fkey(status))'

/** A verifikat in one of these no longer books anything: a pointer at one is stale. */
export const SPENT_ENTRY_STATUSES: ReadonlySet<string> = new Set(['reversed', 'cancelled'])

/** A to-one embed, which PostgREST answers as an object or, resolving it another way, a one-element array. */
type Embedded<T> = T | T[] | null | undefined
const oneOf = <T>(embed: Embedded<T>): T | null => (Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null))

export interface DocumentHoldRow {
  document_hold?: Embedded<{ journal_entry_id: string | null; entry?: Embedded<{ status: string | null }> }>
}

/**
 * The row as the readings above take it: document_journal_entry_id names the
 * verifikat that holds the item's document and still books it. A link is
 * permanent, so a document on a reversed verifikat stays there, but nothing
 * books the purchase any more and the item is open again. Whether such a
 * document can go on another verifikat is a different question, and no.
 */
export function withDocumentHold<Row extends DocumentHoldRow>(row: Row): Omit<Row, 'document_hold'> & { document_journal_entry_id: string | null } {
  const { document_hold, ...rest } = row
  const hold = oneOf(document_hold)
  const status = oneOf(hold?.entry)?.status
  const held = !!hold?.journal_entry_id && !(status && SPENT_ENTRY_STATUSES.has(status))
  return { ...rest, document_journal_entry_id: held ? (hold?.journal_entry_id ?? null) : null }
}
