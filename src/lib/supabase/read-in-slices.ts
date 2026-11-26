import { chunk } from '@/lib/utils'

/**
 * Ids per PostgREST `.in()` read. supabase-js puts the list in the GET query
 * string, about 39 characters a uuid, and a gateway refuses a long one before
 * PostgREST sees it: a self-hosted Kong with the stock 8 KB header buffer
 * answers 414 (#2395), and hosted Supabase stops at about 16 KB. 100 uuids are
 * about 3.9 KB, under half of the stricter limit with room for the rest of the
 * URL. The one slice size for id reads.
 */
export const ID_READ_CHUNK = 100

/** The rows of every slice, or the error of the first slice that failed. */
export interface SlicedRead<Row> {
  data: Row[]
  error: { message: string } | null
}

/**
 * A read by id list, one request per slice of ID_READ_CHUNK ids, the rows
 * merged in slice order. For a read whose caller takes a `{ data, error }`
 * answer, such as several reads in one Promise.all: the first slice that
 * fails, with an error or by throwing (a slice paged with fetchAllRows),
 * answers for the whole read with no rows. A read with an order or a limit
 * over the whole list sorts and cuts the merged rows itself.
 */
export async function readInSlices<Row>(
  ids: readonly string[],
  read: (slice: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<SlicedRead<Row>> {
  const data: Row[] = []
  for (const slice of chunk(ids, ID_READ_CHUNK)) {
    let result: { data: unknown; error: { message: string } | null }
    try {
      result = await read(slice)
    } catch (err) {
      return { data: [], error: err instanceof Error ? err : new Error(String(err)) }
    }
    if (result.error) return { data: [], error: result.error }
    data.push(...((result.data ?? []) as Row[]))
  }
  return { data, error: null }
}
