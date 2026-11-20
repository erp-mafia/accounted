import type { CollectionsStartState } from './flags'

/**
 * "Skicka aldrig till inkasso" on a customer (customers.collections_excluded):
 * the daily collections batch never proposes the customer's invoices, and
 * a handover or a start from the invoice is refused (eligibility block
 * debtor_excluded). Cases already open carry on. Pure and client-safe.
 */

/** PATCH /api/customers/[id]/collections-exclusion. */
export function customerExclusionPath(customerId: string): string {
  return `/api/customers/${encodeURIComponent(customerId)}/collections-exclusion`
}

/**
 * Whether the customer page offers the flag: exactly when the route's
 * customer_exclusion start path answers (collections offered to the company
 * and the paid capability or a sandbox, connected or not). Hidden while
 * collections is dark, and behind the upgrade note for a company that
 * cannot use it.
 */
export function customerExclusionOffered(start: CollectionsStartState | null | undefined): boolean {
  return start === 'activate' || start === 'ready'
}
