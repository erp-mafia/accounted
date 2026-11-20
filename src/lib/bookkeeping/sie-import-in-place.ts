/**
 * Whether an SIE import is in place: the year's import stands in the ledger
 * as it was written. One definition for every reader that gates on it
 * (scripts/checks/one-definition/sie-import-in-place.mjs).
 *
 * sie_imports carries two lifecycles. job_state is the durable job's state
 * machine, owned by the import RPCs. status is the column from before durable
 * jobs, and on a job row it says less: it stays 'completed' while the import
 * is being undone (request_sie_import_undo leaves it), and a stopped reviewed
 * duplicate repair writes 'completed' too. A row is in place when both agree:
 *   - status is 'completed' (all a legacy row, job_state NULL, has), and
 *   - it has no job, or its job is a completed import (job_kind 'import').
 * job_state alone would read the few job rows a fiscal-year reset marked
 * status 'undone' as in place again, so status stays in the definition.
 */

/** The job half of the reading, as a PostgREST `or` filter. */
export const SIE_IMPORT_IN_PLACE_JOB_FILTER = 'job_state.is.null,and(job_state.eq.completed,job_kind.eq.import)'

/** The filter methods the reading uses, on any query of sie_imports. */
interface InPlaceFilter {
  eq(column: string, value: string): InPlaceFilter
  or(filters: string): InPlaceFilter
}

/** The SIE imports that are in place, as a filter on a query of sie_imports. */
export function whereSieImportInPlace<Query>(query: Query): Query {
  return (query as unknown as InPlaceFilter)
    .eq('status', 'completed')
    .or(SIE_IMPORT_IN_PLACE_JOB_FILTER) as unknown as Query
}
