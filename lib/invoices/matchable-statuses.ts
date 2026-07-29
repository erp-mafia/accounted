/**
 * Invoice statuses a bank transaction can still be matched against.
 *
 * These mirror the CAS guards the match routes actually enforce:
 *   app/api/transactions/[id]/match-invoice/route.ts          (.in('status', ...))
 *   app/api/transactions/[id]/match-supplier-invoice/route.ts (.in('status', ...))
 *
 * Every surface that offers a match (suggestion lists, the match dialog, the
 * batch-allocation picker) must filter on the same lists. Offering a target
 * outside them produces a confirm button that can only ever fail with
 * MATCH_INVOICE_ALREADY_PAID / MATCH_SI_ALREADY_PAID.
 *
 * Dependency-free on purpose: client components import this too.
 */
export const MATCHABLE_INVOICE_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

export const MATCHABLE_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'overdue',
  'partially_paid',
] as const

/**
 * A candidate is matchable when its status is still open AND it has an
 * outstanding balance. Both columns are NOT NULL in the schema (migrations
 * 20240101000025 / 20260323120001), so a missing value cannot silently hide a
 * legitimate suggestion here.
 */
export function isMatchableInvoice(
  candidate: { status?: string | null; remaining_amount?: number | null } | null | undefined,
): boolean {
  if (!candidate?.status) return false
  return (
    (MATCHABLE_INVOICE_STATUSES as readonly string[]).includes(candidate.status) &&
    (candidate.remaining_amount ?? 0) > 0
  )
}

export function isMatchableSupplierInvoice(
  candidate: { status?: string | null; remaining_amount?: number | null } | null | undefined,
): boolean {
  if (!candidate?.status) return false
  return (
    (MATCHABLE_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(candidate.status) &&
    (candidate.remaining_amount ?? 0) > 0
  )
}
