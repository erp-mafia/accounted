/**
 * The one rule for "an open deadline": not completed and not dismissed.
 *
 * A deadline leaves the open set two ways. `is_completed` is set when the
 * user ticks it off or a filing completes it. `dismissed_at` is the durable
 * opt-out for a system deadline (DELETE /api/deadlines/[id] keeps the row so
 * the generator does not recreate it). Either way it must never be listed,
 * counted or called overdue again, in the app or for an agent.
 *
 * The stored `status` column is not part of the rule: ticking a deadline off
 * leaves the status it had ('overdue' included), so a reader that trusts the
 * status alone shows finished work as late.
 */

/**
 * The PostgREST filters the rule needs. The constraint names the methods
 * only: checking their full signatures against a PostgrestFilterBuilder makes
 * tsc give up (TS2589), the same reason lib/invoices/overdue.ts does this.
 */
interface DeadlineFilterQuery {
  eq(column: string, value: boolean): DeadlineFilterQuery
  is(column: string, value: null): DeadlineFilterQuery
}

type FilterableQuery = { [K in keyof DeadlineFilterQuery]: unknown }

/** Narrows a `deadlines` query to the open ones. */
export function filterOpenDeadlines<Q extends FilterableQuery>(query: Q): Q {
  return (query as unknown as DeadlineFilterQuery)
    .eq('is_completed', false)
    .is('dismissed_at', null) as unknown as Q
}

/** The same rule for a row already in memory. */
export function isOpenDeadline(deadline: { is_completed: boolean; dismissed_at?: string | null }): boolean {
  return !deadline.is_completed && !deadline.dismissed_at
}
