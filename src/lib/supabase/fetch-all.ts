import { createLogger } from '@/lib/logger'
import { dbError } from '@/lib/errors/db-error'

const log = createLogger('fetch-all')

const PAGE_SIZE = 1000

/**
 * Pages in flight at once after the read has proven large. The first two
 * pages go one by one, so a read of at most two pages (nearly all of them)
 * issues exactly the requests it always did; from the third page on, a read
 * that is still full fetches the next pages side by side and keeps them in
 * order. A register of 31 600 invoices took 32 round trips in a row; now 12.
 * Small on purpose: every page is its own OFFSET query on the pool.
 */
const PAGES_IN_FLIGHT = 3
const SEQUENTIAL_PAGES = 2

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
  /**
   * Stop paging once this many rows are collected, and return at most this
   * many. The replacement for `.limit(N)` with N above one page: PostgREST's
   * max-rows answers such a read with 1000 rows and no error, so the cap was
   * silently 1000 instead of N. A caller that flags truncation compares the
   * result length against the same number.
   */
  maxRows?: number
  /**
   * Called once with the first page when that page is full, so more may
   * follow, before the rest is fetched. For a list that shows its first rows
   * while the older ones arrive: a caller that waits for the returned promise
   * still gets every row, in order, as without it. Never called for a result
   * shorter than one page (the promise resolves at once with the same rows).
   */
  onFirstPage?: (rows: T[]) => void
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
 * The callback receives `{ from, to }` range values: build the query inside
 * it and append `.range(from, to)`, AFTER a stable `.order()`. A new query
 * per call is part of the contract: the later pages of a long read are
 * fetched side by side, and `.range()` changes a query in place, so pages
 * ranged on one query made outside the callback all go out with the last
 * page's range and the rows between them are never read.
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
 *   ({ from, to }) => linesOf(entryId).order('id').range(from, to), // linesOf: a new query per call
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

  const readPage = async (start: number): Promise<T[]> => {
    const { data, error } = await queryFn({ from: start, to: start + PAGE_SIZE - 1 })
    // dbError, not `new Error(error.message)`: the bare form discarded the
    // driver's SQLSTATE, and `isTransientFailure()` checks that code FIRST.
    // A statement timeout (57014) therefore arrived as an anonymous Error and
    // resolved to UNKNOWN_ERROR ("Något gick fel. Försök igen.") instead of
    // the retryable TRANSIENT_ERROR. This is the single highest-traffic strip
    // point in the codebase: every paginated read goes through it, including
    // gnubok_query_journal, which failed 164 times in 60 days at a p50 of
    // 8 110 ms while every other failing tool sat between 1 and 315 ms.
    //
    // The message is kept VERBATIM (context: null). Callers such as
    // query_journal's sanitizeDbError already match on it, and this change is
    // meant to add the code, not to reword anything.
    if (error) throw dbError(error, null)
    return data ?? []
  }
  const capReached = () => options?.maxRows !== undefined && allRows.length >= options.maxRows

  while (true) {
    // A large read (two full pages behind it): the next pages at once, kept
    // in order, up to the first page that is not full. A page after a short
    // one cannot hold rows (the order is total), so stopping there loses
    // nothing; a cap is never read past.
    const inFlight =
      pages < SEQUENTIAL_PAGES
        ? 1
        : Math.max(1, Math.min(
            PAGES_IN_FLIGHT,
            options?.maxRows === undefined ? PAGES_IN_FLIGHT : Math.ceil((options.maxRows - allRows.length) / PAGE_SIZE),
          ))
    const window = await Promise.all(Array.from({ length: inFlight }, (_, i) => readPage(from + i * PAGE_SIZE)))
    let done = false
    for (const data of window) {
      if (data.length === 0) {
        done = true
        break
      }
      allRows.push(...data)
      pages += 1
      if (data.length < PAGE_SIZE || capReached()) {
        done = true
        break
      }
      if (pages === 1) options?.onFirstPage?.(data)
    }
    if (done) break
    from += inFlight * PAGE_SIZE
  }
  if (options?.maxRows !== undefined && allRows.length > options.maxRows) allRows.length = options.maxRows

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
