/**
 * What a credit note is, one answer for every list, payment gate, report and
 * query. In the ledger's folder because the reports and the kontantmetod
 * cut-off read it too, and the kernel never imports lib/invoices.
 *
 * Dependency-free on purpose: client components import this too.
 */

/** The two facts of a row that say it is a credit note. Rows read untyped pass too. */
interface CreditNoteFacts {
  credited_invoice_id?: unknown
  total?: unknown
}

/**
 * Whether a document of document_type 'invoice' is itself a credit note
 * (kreditfaktura, ändringsfaktura in ML 17 kap 22-23 §§). One issued in-app
 * points at its original (credited_invoice_id). One imported at a system
 * change often does not (the provider named no original, or the import
 * predates the pairing pass) and older imports carry an open-looking status
 * such as 'paid', but every one totals below zero, as does any invoice that
 * only takes money back. Pure, so a page reads the rule the doors refuse by.
 *
 * A read that needs the original itself (its number on the PDF, the refund
 * plan) asks credited_invoice_id: this says what the document is. It does not
 * read document_type: no other kind has a link or a total below zero.
 */
export function isCreditNoteDocument(invoice: CreditNoteFacts): boolean {
  return !!invoice.credited_invoice_id || Number(invoice.total ?? 0) < 0
}

/**
 * A kreditfaktura the provider migration imported as settled. Accounted
 * issues its own credit notes as 'sent' (issue-credit-note.ts) and reserves
 * 'credited' for the invoice a credit note reverses. The migration gives
 * every imported credit note 'credited' instead, as a terminal state with
 * nothing paid and nothing remaining: the provider had already netted it into
 * the balance of the invoice it credits, whose paid_amount carries it, so
 * reading it like an original counts each credit a second time.
 */
export function isSettledCreditNote(invoice: CreditNoteFacts & { status?: unknown }): boolean {
  return invoice.status === 'credited' && isCreditNoteDocument(invoice)
}

/**
 * The PostgREST filters excludeCreditNotes needs. It takes any builder that
 * has them and hands the same builder type back. The constraint names the
 * methods only: checking their full signatures against a
 * PostgrestFilterBuilder makes tsc give up (TS2589, instantiation too deep).
 */
interface CreditNoteFilterQuery {
  is(column: string, value: null): CreditNoteFilterQuery
  gte(column: string, value: number): CreditNoteFilterQuery
}

/**
 * Narrows an `invoices` query to the rows isCreditNoteDocument answers false
 * for. invoices.total defaults to 0 and no row has it null, so `gte` reads it
 * as the predicate does.
 */
export function excludeCreditNotes<Q extends { [K in keyof CreditNoteFilterQuery]: unknown }>(query: Q): Q {
  return (query as unknown as CreditNoteFilterQuery)
    .is('credited_invoice_id', null)
    .gte('total', 0) as unknown as Q
}

/**
 * The same rule as arms of a PostgREST `or`, for a query that keeps the
 * credit notes (the complement of excludeCreditNotes). Filter syntax, not
 * user input.
 */
export const CREDIT_NOTE_OR_ARMS = 'credited_invoice_id.not.is.null,total.lt.0'

/**
 * The rows that have an issue step, as arms of a PostgREST `or`: a linked
 * credit note has its own, and what totals zero or more is no credit note.
 * Left out is a negative row with no link, which no door issues (issuable),
 * so nothing asks to have it sent.
 */
export const HAS_ISSUE_STEP_OR_ARMS = 'credited_invoice_id.not.is.null,total.gte.0'
