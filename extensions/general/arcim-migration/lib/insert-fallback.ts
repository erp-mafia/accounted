/**
 * Chunked inserts during migration are one PostgREST statement per chunk,
 * which Postgres treats as all-or-nothing: a single bad row (usually a
 * 23505 unique violation) rejects every row in the chunk. Historically that
 * surfaced as "300 misslyckades" with zero explanation of which row broke.
 *
 * This helper keeps the fast path (one bulk insert) and, only when the bulk
 * statement fails, retries the same rows one at a time so healthy rows still
 * land and the real per-row error becomes visible.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PerRowInsertOutcome {
  /**
   * Selected columns of each inserted row, index-aligned with the input.
   * null = that row failed to insert.
   */
  returned: (Record<string, unknown> | null)[]
  failedCount: number
  /** First database error message, for result summaries and logs. */
  firstError: string | null
}

export async function insertWithPerRowFallback(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  select: string,
): Promise<PerRowInsertOutcome> {
  if (rows.length === 0) {
    return { returned: [], failedCount: 0, firstError: null }
  }

  const bulk = await supabase.from(table).insert(rows).select(select)
  if (!bulk.error) {
    const data = (bulk.data ?? []) as unknown as Record<string, unknown>[]
    // PostgREST returns inserted rows in input order, so a full-length result
    // pairs 1:1 with the input.
    if (data.length === rows.length) {
      return { returned: data, failedCount: 0, firstError: null }
    }
    // The statement SUCCEEDED but returned fewer rows than sent (an RLS
    // read-back gap). The rows ARE in the table, so retrying per row would
    // duplicate them: pair what came back and report the tail unpaired.
    const returned: (Record<string, unknown> | null)[] = new Array(rows.length).fill(null)
    for (let i = 0; i < data.length; i++) returned[i] = data[i]
    return {
      returned,
      failedCount: rows.length - data.length,
      firstError: `insert returned ${data.length} of ${rows.length} rows; unreturned rows were inserted but could not be paired`,
    }
  }

  const returned: (Record<string, unknown> | null)[] = new Array(rows.length).fill(null)
  let failedCount = 0
  let firstError: string | null = bulk.error?.message ?? null

  for (let i = 0; i < rows.length; i++) {
    const single = await supabase.from(table).insert(rows[i]).select(select)
    if (single.error) {
      failedCount++
      firstError ??= single.error.message
      // Keep the first PER-ROW error too: the bulk message is often the same,
      // but when it isn't, the row-level one names the actual offender.
      if (failedCount === 1 && single.error.message) {
        firstError = single.error.message
      }
      continue
    }
    const data = (single.data ?? []) as unknown as Record<string, unknown>[]
    returned[i] = data[0] ?? null
    if (!returned[i]) failedCount++
  }

  return { returned, failedCount, firstError }
}
