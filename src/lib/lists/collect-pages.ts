/**
 * PostgREST answers at most this many rows per request (Supabase's default
 * `max_rows`). A larger `.range()` or `limit` does not fail: it comes back
 * silently cut at this size, so a list that asked for more must ask again.
 */
export const MAX_ROWS_PER_REQUEST = 1000

export interface PageResult<T> {
  data: T[]
  /** The source's exact total, when it reports one. */
  count?: number | null
}

export interface CollectedPages<T> {
  data: T[]
  /** The last total the source reported, or null when it reports none. */
  count: number | null
}

export interface CollectPagesOptions {
  /** Rows wanted in total. `Infinity` collects until the source runs out. */
  want: number
  /** Rows asked for per request, capped at MAX_ROWS_PER_REQUEST. */
  chunkSize?: number
}

/**
 * Collects rows from an offset/limit source one chunk at a time, for list
 * views that show more rows than one request may return: "Alla" on the
 * verifikat list, or a window the user has grown with "Visa fler" and that a
 * refresh must reload whole.
 *
 * `fetchPage(offset, limit)` returns one page; offsets count from the first
 * row this call should return. Collection stops when `want` rows are in,
 * when a page comes back empty, or when the source's reported `count` is
 * reached. Without a count, a page shorter than asked for ends it; with a
 * count, a short page (a server cap below the chunk size) just moves the
 * offset on, so a lower cap can never truncate the list silently.
 *
 * Errors are not caught: a failed page fails the whole collection, so a
 * caller never renders a partial list as if it were complete.
 */
export async function collectPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<PageResult<T>>,
  { want, chunkSize = MAX_ROWS_PER_REQUEST }: CollectPagesOptions,
): Promise<CollectedPages<T>> {
  const size = Math.min(Math.max(1, Math.floor(chunkSize)), MAX_ROWS_PER_REQUEST)
  const data: T[] = []
  let count: number | null = null

  while (data.length < want) {
    const limit = Math.min(size, want - data.length)
    const page = await fetchPage(data.length, limit)
    if (typeof page.count === 'number') count = page.count
    if (page.data.length === 0) break
    data.push(...page.data)
    if (count !== null ? data.length >= count : page.data.length < limit) break
  }

  return { data, count }
}
