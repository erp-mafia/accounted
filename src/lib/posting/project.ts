import type { HandleType } from '@/lib/handles/registry'
import type { JournalEntry, JournalEntrySourceType } from '@/types'
import { kindForSourceType, type BusinessEventKind } from './kinds'
import type { BusinessEventEntryRole } from './store'

/**
 * The read-side projection for history: "what kind of business event was
 * this verifikat?" for an entry that has no business_events row, i.e. every
 * entry posted before the port and every entry of a producer not moved onto
 * it yet. History is never backfilled (a link is accepted only to a draft,
 * migration 20261016220000), so this is answered from what the entry itself
 * says: its source type, its source id and its date.
 *
 * Only what the row states is projected. category, party, amounts and the
 * mapping version are not on a verifikat and are left out rather than
 * guessed; a subject is given only for the source types whose source_id is
 * known to name that record.
 */
export interface ProjectedBusinessEvent {
  /** Distinguishes a projection from a recorded event. */
  readonly source: 'projection'
  readonly journal_entry_id: string
  /** null for a source type outside the list (a row from a newer schema). */
  readonly kind: BusinessEventKind | null
  readonly role: BusinessEventEntryRole
  /** The verifikat's date: the best a projection has for when it happened. */
  readonly occurred_on: string
  readonly subject: { readonly type: HandleType; readonly id: string } | null
}

/**
 * The source types whose source_id is the id of a record with a typed
 * handle, as the generators write them (transaction-entries.ts,
 * invoice-entries.ts, supplier-invoice-entries.ts, expense-claims-service.ts).
 * A storno copies its original's source_id but not its type, so it has none.
 */
const SUBJECT_TYPE_BY_SOURCE_TYPE: Readonly<Partial<Record<JournalEntrySourceType, HandleType>>> = Object.freeze({
  bank_transaction: 'transaction',
  invoice_created: 'invoice',
  invoice_paid: 'invoice',
  invoice_cash_payment: 'invoice',
  credit_note: 'invoice',
  supplier_invoice_registered: 'supplier_invoice',
  supplier_invoice_paid: 'supplier_invoice',
  supplier_invoice_cash_payment: 'supplier_invoice',
  supplier_invoice_privately_paid: 'supplier_invoice',
  supplier_credit_note: 'supplier_invoice',
  expense_claim: 'expense_claim',
})

export function projectBusinessEvent(
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id' | 'entry_date'>,
): ProjectedBusinessEvent {
  const subjectType = SUBJECT_TYPE_BY_SOURCE_TYPE[entry.source_type as JournalEntrySourceType]
  return {
    source: 'projection',
    journal_entry_id: entry.id,
    kind: kindForSourceType(entry.source_type),
    role: entry.source_type === 'storno' ? 'reversal' : entry.source_type === 'correction' ? 'correction' : 'produced',
    occurred_on: entry.entry_date,
    subject: subjectType && entry.source_id ? { type: subjectType, id: entry.source_id } : null,
  }
}
