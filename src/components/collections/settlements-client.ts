'use client'

/**
 * Browser side of the settlements view (Avräkningar): the calls to the
 * routes. The pure decisions live in lib/collections/settlements-ui.ts.
 */

export type RouteResult<T> = { ok: true; data: T } | { ok: false; body: unknown }

/**
 * Call a collections route by its full path (callers write it out, so a
 * reader can find the route file); a refusal comes back as its JSON body
 * for getErrorMessage.
 */
export async function settlementsCall<T>(path: `/api/collections/${string}`, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<RouteResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
    const json = (await res.json().catch(() => null)) as { data?: T } | null
    if (res.ok && json && 'data' in json) return { ok: true, data: json.data as T }
    return { ok: false, body: json }
  } catch (error) {
    return { ok: false, body: error }
  }
}
