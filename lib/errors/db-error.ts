/**
 * Wrap a Supabase/PostgREST error without throwing away its identity.
 *
 * ## The bug this exists to prevent
 *
 * The idiom across the MCP tools was:
 *
 *     if (error) throw new Error(`Database error: ${error.message}`)
 *
 * which keeps the prose and discards `code`. That matters because `code` is
 * the SQLSTATE, and `isTransientFailure()` in lib/errors/get-structured-error.ts
 * checks it FIRST: `57014` (statement timeout), `40001`, `40P01`, `53300` and
 * friends are already in its TRANSIENT_SQLSTATES set. Strip the code and a
 * retryable timeout arrives as an anonymous Error, misses every transient
 * check, and resolves to UNKNOWN_ERROR: "Något gick fel. Försök igen."
 *
 * Measured on production over 60 days (bot actors excluded): 1 024 real-agent
 * tool failures, 645 of them UNKNOWN_ERROR across 60 actors and 57 companies,
 * 537 carrying that exact generic string. `gnubok_query_journal` alone failed
 * 164 times at a p50 of 8 110 ms while every other failing tool sat between 1
 * and 315 ms: a timeout signature that should have been TRANSIENT_ERROR all
 * along. Agents cannot dispatch on "something went wrong", so they retried:
 * 82 streaks of three or more identical failures, 462 wasted repeat calls,
 * 53.1% of all real-agent error calls sitting inside a streak.
 *
 * ## Why attaching `code` is safe
 *
 * `extractCode()` only treats a code as an application error code when it
 * matches /^[A-Z_]+$/. Every SQLSTATE contains digits (`57014`, `42P01`,
 * `23505`), and so does every PostgREST code (`PGRST200`), so none of them can
 * be mistaken for one of our own stable codes. The only behaviour this unlocks
 * is the transient check that was always meant to run.
 */

/** The shape of a PostgrestError, narrowed to what we read. */
interface DatabaseErrorLike {
  message?: string | null
  code?: string | null
  details?: string | null
  hint?: string | null
}

/**
 * An Error carrying the driver's SQLSTATE and diagnostics.
 *
 * `details` and `hint` are preserved for the server log, not for the agent:
 * `getStructuredError` never reads them, so they cannot leak into a tool
 * result. They are what makes a production failure debuggable after the fact.
 */
export interface DatabaseError extends Error {
  code?: string
  details?: string
  hint?: string
}

/**
 * @param error   the `error` half of a supabase-js `{ data, error }` result
 * @param context prefix for the message; defaults to the historical
 *                "Database error" so existing message-pattern matching in
 *                `inferCode()` keeps working unchanged. Pass `null` to keep
 *                the driver's message verbatim, for call sites whose exact
 *                text callers already depend on.
 */
export function dbError(error: unknown, context: string | null = 'Database error'): DatabaseError {
  const source = (error ?? {}) as DatabaseErrorLike
  const raw = typeof source.message === 'string' && source.message.trim() ? source.message.trim() : null

  // Never render the literal "undefined". A driver-level failure (an aborted
  // fetch, a gateway timeout) can arrive with no `message` at all, and
  // "Database error: undefined" is the string that made these unsearchable in
  // the first place.
  const prefix = context ?? ''
  const message = raw
    ? (prefix ? `${prefix}: ${raw}` : raw)
    : `${prefix || 'Database error'}: no message from the database driver`

  const wrapped = new Error(message) as DatabaseError
  if (typeof source.code === 'string' && source.code) wrapped.code = source.code
  if (typeof source.details === 'string' && source.details) wrapped.details = source.details
  if (typeof source.hint === 'string' && source.hint) wrapped.hint = source.hint
  return wrapped
}

/**
 * A PII-safe identifier for what failed, for telemetry.
 *
 * A SQLSTATE is five characters of protocol vocabulary and carries no tenant
 * data. A raw driver message can quote row values in a constraint violation,
 * so it belongs in the server log, never in `event_log`.
 */
export function errorCauseTag(error: unknown): string | null {
  if (error === null || error === undefined) return null
  const source = error as DatabaseErrorLike & { name?: unknown }
  if (typeof source.code === 'string' && source.code) return source.code
  if (error instanceof Error && error.name && error.name !== 'Error') return error.name
  return null
}
