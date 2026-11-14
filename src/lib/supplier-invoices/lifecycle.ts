/**
 * Supplier-invoice lifecycle helpers for the 'overdue' label.
 *
 * 'overdue' is derived state (an unpaid payable past its due date) that we
 * store as a lifecycle status: the daily pg_cron job
 * update_overdue_supplier_invoices() flips 'registered'/'approved' rows there.
 * Because it is stored rather than computed, every path that can change
 * due_date, or that gates on the status, has to use the same predicate as the
 * cron. When they diverge the label sticks: before #1206 nothing ever flipped
 * back, so an unbooked invoice that aged past its due date became read-only
 * and could not even have its due date extended.
 *
 * Keep this file in sync with update_overdue_supplier_invoices()
 * (supabase/migrations/20261101120100_stockholm_today.sql).
 * The SQL also skips migration-reset archives, whose rows are frozen; that is
 * a company-level guard, not part of this row-level predicate.
 */

import { isPastDue } from '@/lib/dates/iso'

/**
 * "Nothing left to pay" threshold, mirroring the cron and the payment/match
 * paths: öre-level rounding must not leave a payable looking unsettled.
 */
export const FULLY_PAID_EPSILON = 0.005

/**
 * Statuses the overdue flip/un-flip owns. They are also exactly the statuses
 * in which an invoice is still unsettled, so metadata editing is allowed:
 * 'paid'/'partially_paid'/'credited'/'reversed'/'disputed' are settled or
 * disputed states that other flows own.
 */
export const UNSETTLED_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'overdue',
] as const

export type UnsettledSupplierInvoiceStatus =
  (typeof UNSETTLED_SUPPLIER_INVOICE_STATUSES)[number]

export function isUnsettledSupplierInvoiceStatus(
  status: string,
): status is UnsettledSupplierInvoiceStatus {
  return (UNSETTLED_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(status)
}

/** The facts the overdue predicate reads. `today` is an ISO yyyy-MM-dd date. */
export type SupplierInvoiceLifecycleFacts = {
  due_date: string
  remaining_amount: number
  is_credit_note?: boolean | null
  /** Set when the invoice has been attested; null/undefined when it has not. */
  approved_at?: string | null
}

/**
 * True when the invoice is a payable that has fallen due: the exact predicate
 * update_overdue_supplier_invoices() flips on. Credit notes are not payables,
 * and a fully settled row has nothing to fall due.
 */
export function isOverduePayable(
  facts: Pick<SupplierInvoiceLifecycleFacts, 'due_date' | 'remaining_amount' | 'is_credit_note'>,
  today: string,
): boolean {
  if (facts.is_credit_note) return false
  if (facts.remaining_amount <= FULLY_PAID_EPSILON) return false
  return isPastDue(facts.due_date, today)
}

/**
 * The status an unsettled invoice should rest at right now.
 *
 * The flip collapses 'registered' and 'approved' into 'overdue', so the way
 * back needs approved_at: without it an un-flip would silently strip an
 * attested invoice of its approval (and with it the "Markera som betald"
 * path). Rows that were already 'overdue' when approved_at was introduced
 * carry no timestamp and therefore return to 'registered', where they can be
 * re-approved.
 */
export function resolveUnsettledStatus(
  facts: SupplierInvoiceLifecycleFacts,
  today: string,
): UnsettledSupplierInvoiceStatus {
  if (isOverduePayable(facts, today)) return 'overdue'
  return facts.approved_at ? 'approved' : 'registered'
}

/**
 * True when the company has an attest step for supplier invoices at all.
 * Kontantmetoden companies never attest: the debt is not booked before
 * payment, so their ladder skips Attesterad (stages.ts) and no page offers the
 * button. One rule for the pages and the Att göra count
 * (lib/worklist countSupplierInvoicesAwaitingApproval): while the count kept
 * its own population, cash-method companies got an attest item nobody could
 * clear (crm#1156). A company without a setting reads as faktureringsmetoden,
 * as it always has on the pages.
 */
export function companyAttestsSupplierInvoices(
  accountingMethod: string | null | undefined,
): boolean {
  return accountingMethod !== 'cash'
}

/**
 * The statuses an invoice can still be attested in, while approved_at is
 * null. 'overdue' is included because the cron puts unattested invoices there
 * just by aging. Read by canApproveSupplierInvoice and by the Att göra count
 * (lib/worklist countSupplierInvoicesAwaitingApproval), so the count holds
 * exactly the invoices the pages offer Attestera on (crm#1631).
 */
export const ATTESTABLE_SUPPLIER_INVOICE_STATUSES = ['registered', 'overdue'] as const

/**
 * True when the invoice can still be attested
 * (ATTESTABLE_SUPPLIER_INVOICE_STATUSES); approved_at (not the status) is
 * what makes approval idempotent.
 */
export function canApproveSupplierInvoice(invoice: {
  status: string
  approved_at?: string | null
}): boolean {
  if (invoice.approved_at) return false
  return (ATTESTABLE_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(invoice.status)
}

/**
 * The statuses past the attest step: attest moves 'registered' to 'approved',
 * and an invoice that aged ('overdue') or is part paid ('partially_paid') is
 * payable whatever its attest state, so it never gets stuck behind attest.
 */
const PAYABLE_AFTER_ATTEST_STATUSES = ['approved', 'overdue', 'partially_paid'] as const

/**
 * The statuses in which the product offers to settle a supplier invoice by
 * hand: "Markera som betald" (with its "Befintlig verifikation" tab, the link
 * to a verifikat already booked from the bank) and the "Inlagd i banken" mark
 * right before it (#2220).
 *
 * Where the company attests, 'registered' waits for attest. Kontantmetoden
 * has no attest step (companyAttestsSupplierInvoices), so there a registered
 * invoice is payable as it stands. The pages used to hold the attesting
 * company's list for everyone, so a kontantmetod invoice could only be marked
 * paid once the overdue cron had moved it past its due date (crm#1141).
 *
 * The settlement doors themselves (mark-paid, link-to-voucher, the bank
 * match) accept every unsettled status for every company
 * (lib/bookkeeping/matchable-statuses.ts); this is what the product offers.
 */
export function payableSupplierInvoiceStatuses(
  accountingMethod: string | null | undefined,
): readonly string[] {
  return companyAttestsSupplierInvoices(accountingMethod)
    ? PAYABLE_AFTER_ATTEST_STATUSES
    : ['registered', ...PAYABLE_AFTER_ATTEST_STATUSES]
}

/**
 * True when "Markera som betald" is offered for the invoice. One rule for the
 * detail page and the "Inlagd i banken" mark. What waits to be paid (the
 * Att betala tab, to_pay) is lib/supplier-invoices/to-pay.ts.
 */
export function canMarkSupplierInvoicePaid(
  invoice: { status: string },
  accountingMethod: string | null | undefined,
): boolean {
  return payableSupplierInvoiceStatuses(accountingMethod).includes(invoice.status)
}

/**
 * True when the user may mark the invoice as entered at the bank by hand.
 * The mark is the step right before "Markera som betald", so it is offered on
 * exactly those rows; the compare-and-set in setSupplierInvoiceBankEntered
 * (manage.ts) reads the same statuses. A credit note is never a payment
 * instruction, so it can never be "in the bank". Clearing the mark is always
 * allowed and does not go through here.
 */
export function canMarkSupplierInvoiceBankEntered(
  invoice: { status: string; is_credit_note?: boolean | null },
  accountingMethod: string | null | undefined,
): boolean {
  if (invoice.is_credit_note) return false
  return canMarkSupplierInvoicePaid(invoice, accountingMethod)
}

/**
 * Fields that are copied onto the registration verifikat when it is posted:
 *
 *   - invoice_date   -> journal_entries.entry_date (and the fiscal period the
 *                       entry was filed in), lib/bookkeeping/supplier-invoice-entries.ts
 *   - supplier_invoice_number -> the verifikat description ("Leverantörsfaktura
 *                       <nr>, <leverantör>") and every line_description built
 *                       from it
 *
 * BFL 5 kap 6-7 § makes "datum för affärshändelsen" and the identification of
 * the underlying verifikation mandatory verifikat content, and 5 kap 5 §
 * requires a correction to leave the original visible. Rewriting either field
 * on the invoice row after the entry is posted satisfies neither: the entry
 * keeps its original values, nothing lands in journal_entry_rattelse_log, and
 * the invoice and its verifikat silently disagree (#1230).
 */
export const VERIFIKAT_CRITICAL_SUPPLIER_INVOICE_FIELDS = [
  'invoice_date',
  'supplier_invoice_number',
] as const

export type VerifikatCriticalSupplierInvoiceField =
  (typeof VERIFIKAT_CRITICAL_SUPPLIER_INVOICE_FIELDS)[number]

/**
 * The verifikat-critical fields an update would actually move, ignoring
 * whether an entry has been posted yet.
 *
 * Only a *differing* value is reported: clients that PUT the whole form back
 * (the dashboard edit dialog resends every field it rendered) must keep
 * working, and resending the stored value changes nothing on the verifikat.
 * Amounts and accounts are not listed because the update schema cannot reach
 * them; the damage this guards against is metadata drift, not entry balance.
 */
export function findChangedVerifikatFields(
  // Callers hand over the whole validated update body, so unrelated keys
  // (due_date, notes, ...) have to be accepted rather than stripped first.
  update: Partial<Record<VerifikatCriticalSupplierInvoiceField, string | null | undefined>> & {
    [key: string]: unknown
  },
  existing: Partial<Record<VerifikatCriticalSupplierInvoiceField, string | null>>,
): VerifikatCriticalSupplierInvoiceField[] {
  return VERIFIKAT_CRITICAL_SUPPLIER_INVOICE_FIELDS.filter((field) => {
    const next = update[field]
    if (next === undefined) return false
    return next !== (existing[field] ?? null)
  })
}

/**
 * The verifikat-critical fields an update would change on an invoice whose
 * registration entry is already posted. Empty means the update is safe.
 *
 * An empty result on an as-yet unbooked invoice is only true as of the read it
 * was computed from: a registration entry can be posted between that read and
 * the write. Callers must therefore pin `registration_journal_entry_id is null`
 * on the update itself whenever findChangedVerifikatFields() is non-empty and
 * this returns empty, so a concurrent posting turns into zero matched rows
 * rather than the very drift this guards against.
 */
export function findLockedVerifikatFields(
  update: Partial<Record<VerifikatCriticalSupplierInvoiceField, string | null | undefined>> & {
    [key: string]: unknown
  },
  existing: {
    registration_journal_entry_id?: string | null
  } & Partial<Record<VerifikatCriticalSupplierInvoiceField, string | null>>,
): VerifikatCriticalSupplierInvoiceField[] {
  if (!existing.registration_journal_entry_id) return []
  return findChangedVerifikatFields(update, existing)
}
