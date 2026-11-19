import { isMissingColumnError } from './agent-reason'

/**
 * Run a pending_operations read that names operation_number, and once more
 * without it when the column is not there yet: the code is live before the
 * migration that adds it (20261117192101) runs. `run` builds the whole query
 * for each case, with its select list spelled as a literal so the schema
 * guard (tests/schema) can check every column.
 *
 * Only for reads that list their columns: a `select('*')` gets the number
 * the day the column exists and needs no retry. Server-only (the
 * missing-column check sits beside node:async_hooks in ./agent-reason.ts);
 * what a client needs is in ./operation-number.ts.
 */
export async function readWithOperationNumber<T extends { error: { code?: string } | null }>(
  run: (withOperationNumber: boolean) => PromiseLike<T>,
): Promise<T> {
  const first = await run(true)
  return isMissingColumnError(first.error) ? run(false) : first
}
