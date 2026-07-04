import { createLogger } from '@/lib/logger'

const log = createLogger('fetch-all')

const PAGE_SIZE = 1000

export interface FetchAllRowsOptions<T> {
  /**
   * Stable de-duplication key. When supplied AND more than one page was
   * fetched, rows are de-duplicated by this key after all pages are collected,
   * and a warn is logged if any duplicates were dropped.
   *
   * This is a safety net, NOT the fix: PostgREST `.range()` paging is only
   * correct when the underlying query has a stable TOTAL order (see the
   * ordering invariant below). If a duplicate is ever observed here it means a
   * caller's query is missing that `.order()`: the warn surfaces the
   * regression in logs instead of letting it silently double financial totals.
   * Note this only catches *duplicates*; *skipped* rows can only be prevented
   * by ordering on a unique column at the call site.
   */
  dedupeBy?: (row: T) => string | number
}

/**
 * Fetches all rows from a Supabase query by paginating through results.
 * Overcomes PostgREST's default 1000-row limit.
 *
 * **Ordering invariant:** any query that can return more than `PAGE_SIZE` rows
 * MUST `.order()` on a unique column (e.g. the table's `id` PK). Postgres
 * returns rows in an undefined order that can differ between the two `.range()`
 * requests, so without a stable total order, rows on a page boundary are
 * silently DUPLICATED and/or SKIPPED across pages. For aggregating reports
 * (general ledger, trial balance, grundbok) that means doubled or missing
 * balances. Order is purely for paging stability: callers that need a
 * different display order should re-sort after fetching.
 *
 * The callback receives `{ from, to }` range values: append `.range(from, to)`
 * to your query builder, AFTER a stable `.order()`:
 *
 * ```ts
 * const accounts = await fetchAllRows(({ from, to }) =>
 *   supabase
 *     .from('chart_of_accounts')
 *     .select('account_number, account_name')
 *     .eq('company_id', companyId)
 *     .order('account_number', { ascending: true }) // stable total order
 *     .range(from, to)
 * )
 * ```
 *
 * Pass `{ dedupeBy }` as defense-in-depth for queries where a missing/regressed
 * order would corrupt money:
 *
 * ```ts
 * const lines = await fetchAllRows(
 *   ({ from, to }) => q.order('id').range(from, to),
 *   { dedupeBy: (r) => r.id },
 * )
 * ```
 */
export async function fetchAllRows<T>(
  queryFn: (range: { from: number; to: number }) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>,
  options?: FetchAllRowsOptions<T>
): Promise<T[]> {
  const allRows: T[] = []
  let from = 0
  let pages = 0

  while (true) {
    const { data, error } = await queryFn({ from, to: from + PAGE_SIZE - 1 })
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    allRows.push(...data)
    pages += 1
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Duplicates are only possible across page boundaries, so single-page results
  // never need the dedup pass.
  if (options?.dedupeBy && pages > 1) {
    const seen = new Set<string | number>()
    const deduped: T[] = []
    for (const row of allRows) {
      const key = options.dedupeBy(row)
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(row)
    }
    const dropped = allRows.length - deduped.length
    if (dropped > 0) {
      log.warn(
        'fetchAllRows dropped duplicate rows across pages: a paginated query is missing a stable .order() on a unique column',
        { dropped, total: allRows.length, pages }
      )
      return deduped
    }
  }

  return allRows
}
