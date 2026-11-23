/**
 * A counted page past the last row, answered as the empty page it is.
 *
 * PostgREST refuses a read whose offset lies past the last row with HTTP 416,
 * PGRST103 "Requested range not satisfiable", but only when the request
 * counts rows (Prefer: count=exact); the same read at exactly the row count
 * answers 200 []. Every list that pages by offset and reports a total (the
 * MCP list tools, the app's list routes) passed that refusal on as a database
 * error, so an agent paging on after the last page, or a list that shrank
 * between two pages, was told "Database error ... try again" instead of
 * "no more rows".
 *
 * Normalised once, in the fetch every server client sends with, so no list
 * has to know: the response becomes 200 [] with the total PostgREST names in
 * the refusal's details ("An offset of 40 was requested, but there are only
 * 25 rows.") as its Content-Range, and supabase-js reads data [] and that
 * count, so has_more is false. Only that refusal: a negative limit or a
 * reversed range (the same code, other details) is a caller's bug and passes
 * through, as does every other response.
 *
 * Isomorphic: no server-only imports.
 */

const OUT_OF_BOUNDS_TOTAL = /only (\d+) rows?\b/

/** True for a request to PostgREST (/rest/v1/); a relative URL is none. */
export function isPostgrestRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    return new URL(url).pathname.includes('/rest/v1/')
  } catch {
    // Not an absolute URL, so not a PostgREST request: its response passes through as is.
    return false
  }
}

/**
 * The row total of a PostgREST "offset past the end" refusal, or null for
 * any other response. Reads a clone, so the original body stays unread.
 */
export async function pastEndTotal(response: Response): Promise<number | null> {
  if (response.status !== 416) return null
  let body: unknown
  try {
    body = JSON.parse(await response.clone().text())
  } catch {
    // Not PostgREST's JSON refusal: the caller gets the original response, error and all.
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { code, details } = body as { code?: unknown; details?: unknown }
  if (code !== 'PGRST103' || typeof details !== 'string') return null
  const total = OUT_OF_BOUNDS_TOTAL.exec(details)?.[1]
  return total === undefined ? null : Number(total)
}

/**
 * A fetch for supabase-js (global.fetch) that answers a counted page past
 * the last row as 200 [] with its total. `base` is the fetch to send with,
 * the global one when absent, looked up per request as supabase-js does.
 */
export function withEmptyPagePastEnd(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init)
    if (response.status !== 416 || !isPostgrestRequest(input)) return response
    const total = await pastEndTotal(response)
    if (total === null) return response
    const headers = new Headers(response.headers)
    headers.set('content-range', `*/${total}`)
    headers.set('content-type', 'application/json; charset=utf-8')
    return new Response('[]', { status: 200, statusText: 'OK', headers })
  }
}
