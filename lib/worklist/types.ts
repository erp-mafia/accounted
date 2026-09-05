/**
 * Worklist: the unified "Att göra" pending-work model.
 *
 * One source of truth for what the user still has to do, shared by the
 * dashboard "Att göra" section, the sidebar badges, and (eventually) the
 * MCP list tools. Every surface that shows a pending-work count MUST read
 * it from lib/worklist so the numbers can never diverge: divergent counts
 * are exactly the "vampire transactions" problem this module exists to fix.
 *
 * Each category documents its "done" condition: the status field or link
 * whose write makes an item drop out of the count, everywhere, at once.
 */

export const WORKLIST_CATEGORIES = [
  /**
   * Unbooked bank transactions ("N st att bokföra").
   * Pending:  is_business IS NULL AND is_ignored = false.
   * Done:     any booking flow (categorize, match-invoice, bulk-book RPC,
   *           manual booking) sets is_business = true: including the
   *           multi-tx flows, whose RPCs set is_business on every linked tx:
   *           or the user ignores the transaction (is_ignored = true).
   * This is the canonical "unbooked" predicate. Do NOT count bare
   * journal_entry_id IS NULL: multi-allocation and bulk-booked transactions
   * keep journal_entry_id NULL (see lib/transactions/is-booked.ts).
   */
  'book_transaction',
  /**
   * Unbooked skattekonto rows ("N st skattekontohändelser att bokföra").
   * Pending:  skattekonto_transactions with status = 'booked' (Skatteverket's
   *           "tidigare": the event has happened on the tax account),
   *           journal_entry_id IS NULL and is_ignored = false. Rows with
   *           status = 'upcoming' are future charges with nothing to book
   *           yet and never reach the Transaktioner inbox, so they are not
   *           pending work either.
   * Done:     the skattekonto booking flows set journal_entry_id (here it IS
   *           the booked marker, unlike bank transactions), or the user
   *           ignores the row (is_ignored = true). Same predicate as the
   *           Transaktioner inbox's Skatteverket rows.
   */
  'book_skattekonto',
  /**
   * Unconsumed documents in the inbox ("N st underlag att hantera").
   * Pending:  invoice_inbox_items with a document and no
   *           created_supplier_invoice_id / created_journal_entry_id /
   *           matched_transaction_id, whose document is still unlinked.
   * Done:     any of those three columns gets stamped (match, book-direct,
   *           supplier-invoice conversion) or the document is linked to a
   *           journal entry. Mirrors /api/documents/inbox-available.
   */
  'inbox_document',
  /**
   * Suggested transaction↔invoice matches awaiting one-click confirm.
   * Pending:  unbooked transactions (see book_transaction) carrying a
   *           potential_invoice_id or potential_supplier_invoice_id hint.
   * Done:     the match is confirmed (booking clears is_business) or the
   *           hint column is cleared. NOTE: a subset of book_transaction:
   *           excluded from `total` to avoid double-counting.
   */
  'suggested_match',
  /**
   * Supplier invoices awaiting approval ("attestera").
   * Pending:  supplier_invoices.status = 'registered' and not a credit note
   *           (a credit note is a reversal, never a payable).
   * Done:     status moves to approved/paid/credited/….
   */
  'supplier_invoice_approval',
  /**
   * Posted verifikat without underlag (BFL 5 kap 7§ documentation gap).
   * Pending:  posted journal_entries of document-requiring source types with
   *           no current-version document_attachments row and no
   *           journal_entry_no_doc_required exemption.
   * Done:     a document is linked or an exemption is recorded.
   */
  'verifikat_missing_document',
  /**
   * Overdue customer invoices ("förfallna kundfakturor").
   * Pending:  invoices.status = 'overdue', not credited.
   * Done:     paid/credited (status leaves 'overdue').
   */
  'overdue_invoice',
  /**
   * Tax/VAT deadlines needing attention.
   * Pending:  deadlines.is_completed = false AND status IN
   *           ('action_needed', 'overdue'): same predicate as
   *           lib/deadlines/status-engine.ts getDeadlinesNeedingAttention().
   * Done:     submitted/confirmed (is_completed or status transition).
   */
  'deadline_action',
  /**
   * Agent-staged operations awaiting review ("Granskning").
   * Pending:  pending_operations.status = 'pending'.
   * Done:     committed or rejected.
   */
  'pending_operations',
  /**
   * Accounts not signed off through the end of the previous month
   * ("N konton att stämma av"), only for companies that have adopted the
   * sign-off ritual (at least one account_reconciliations row ever).
   * Pending:  an enabled cash account (deduplicated per IBAN + currency) or a
   *           configured skattekonto whose latest ACTIVE sign-off has
   *           through_date before the last day of the previous month.
   * Done:     a sign-off through that date or later (POST .../signoff), or
   *           the account stops being reconcilable (disabled cash account).
   * Zero for companies with no sign-off at all: the nudge is for those who
   * reconcile monthly, not a new chore for everyone.
   */
  'reconciliation_due',
] as const

export type WorklistCategory = (typeof WORKLIST_CATEGORIES)[number]

export interface WorklistCounts {
  counts: Record<WorklistCategory, number>
  /**
   * Distinct actionable items. Excludes suggested_match, which is a fast
   * path over transactions already counted in book_transaction.
   */
  total: number
}

/** A transaction↔invoice match suggestion, ready for one-click confirm. */
export interface SuggestedMatch {
  transaction_id: string
  transaction_date: string
  transaction_description: string
  transaction_amount: number
  transaction_currency: string
  /**
   * Which match endpoint confirms it: match-invoice, match-supplier-invoice,
   * or match-rot-rut-payout (Skatteverkets utbetalning for an open begäran;
   * candidate_number is then the request name).
   */
  kind: 'invoice' | 'supplier_invoice' | 'rot_rut_payout'
  candidate_id: string
  candidate_number: string | null
  counterparty_name: string | null
  candidate_total: number | null
}

/**
 * Journal-entry source types that require underlag (BFL 5 kap 7 §). Source
 * types representing system-generated entries (VAT settlement, year-end,
 * currency revaluation, ...) are exempt by omission.
 *
 * Single source of truth for EVERY TS surface (worklist counts, journal-list
 * chip/waiver UI, no-doc-required batch route, push notifications); the SQL
 * mirror lives in the verifikat_without_documents RPC, pinned by
 * tests/pg/document-surfaces-unification.pg.test.ts. Lives here (not in
 * categories.ts) because this module is dependency-free and safe to import
 * from client components.
 */
export const NEEDS_DOC_SOURCE_TYPES = [
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
  // Webshop order bookings rest on the generated orderunderlag (#1881); an
  // entry whose underlag failed to attach must surface here.
  'webshop_order',
] as const
