/**
 * Map over `items` with a bounded worker pool, preserving input order in the
 * result array.
 *
 * Built for client batch actions (bulk categorize/ignore/delete) that used to
 * run strictly sequentially: N round trips one after another made a 20-row
 * batch take 10-20s. A small pool keeps the server load bounded (never an
 * unbounded Promise.all over 100 rows) while finishing in a few round trips.
 *
 * `fn` is expected to handle its own errors and resolve with a result value
 * (the batch handlers resolve per-row success/failure objects); a rejection
 * from `fn` rejects the whole map, exactly like Promise.all.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be >= 1, got ${limit}`)
  }
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
