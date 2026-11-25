/**
 * Supplier-invoice lifecycle helpers: the attest step, what may be paid, and
 * the fields copied onto the registration verifikat.
 *
 * The rest status of an unsettled invoice and the 'overdue' predicate live in
 * the ledger kernel (lib/bookkeeping/supplier-invoice-rest-status.ts), so the
 * payment sync reads the same rule; they are re-exported here unchanged.
 */

import {
  UNSETTLED_SUPPLIER_INVOICE_STATUSES,
  type UnsettledSupplierInvoiceStatus,
} from '@/lib/bookkeeping/supplier-invoice-rest-status'

export {
  FULLY_PAID_EPSILON,
  UNSETTLED_SUPPLIER_INVOICE_STATUSES,
  isOverduePayable,
  resolveUnsettledStatus,
  type SupplierInvoiceLifecycleFacts,
  type UnsettledSupplierInvoiceStatus,
} from '@/lib/bookkeeping/supplier-invoice-rest-status'

export function isUnsettledSupplierInvoiceStatus(
  status: string,
): status is UnsettledSupplierInvoiceStatus {
  return (UNSETTLED_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(status)
}

/**
 * True when attest is a step before payment for the company's supplier
 * invoices: the company keeps faktureringsmetoden and has its attest policy
 * on (company_attest_policies.enabled, attest-policy.ts). Everywhere else a
 * registered invoice is ready to pay as it stands, and no page asks for
 * Attestera.
 *
 * Kontantmetoden never attests: the debt is not booked before payment, so
 * its ladder skips Attesterad (stages.ts). Without a policy nothing waits for
 * the attest: the payment file and the Att betala tab take an unattested
 * invoice, so the pages do not ask for it either. Attesting stays possible
 * through the API and MCP (attest-service.ts), and an invoice that carries an
 * attest keeps its mark (approved_at) and its status.
 *
 * One rule for the pages, the Att göra count
 * (lib/worklist countSupplierInvoicesAwaitingApproval) and the payment
 * paths' unattested warning (attest-policy-read.ts): while the count kept its
 * own population, cash-method companies got an attest item nobody could
 * clear (crm#1156). A company without a setting reads as faktureringsmetoden,
 * as it always has on the pages.
 */
export function companyAttestsSupplierInvoices(
  accountingMethod: string | null | undefined,
  attestPolicyOn: boolean | null | undefined,
): boolean {
  return accountingMethod !== 'cash' && attestPolicyOn === true
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
 * and a company without an attest policy have no attest step
 * (companyAttestsSupplierInvoices), so there a registered invoice is payable
 * as it stands. The pages used to hold the attesting company's list for
 * everyone, so a kontantmetod invoice could only be marked paid once the
 * overdue cron had moved it past its due date (crm#1141).
 *
 * The settlement doors themselves (mark-paid, link-to-voucher, the bank
 * match) accept every unsettled status for every company
 * (lib/bookkeeping/matchable-statuses.ts); this is what the product offers.
 */
export function payableSupplierInvoiceStatuses(
  accountingMethod: string | null | undefined,
  attestPolicyOn: boolean | null | undefined,
): readonly string[] {
  return companyAttestsSupplierInvoices(accountingMethod, attestPolicyOn)
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
  attestPolicyOn: boolean | null | undefined,
): boolean {
  return payableSupplierInvoiceStatuses(accountingMethod, attestPolicyOn).includes(invoice.status)
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
  attestPolicyOn: boolean | null | undefined,
): boolean {
  if (invoice.is_credit_note) return false
  return canMarkSupplierInvoicePaid(invoice, accountingMethod, attestPolicyOn)
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
