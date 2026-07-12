/**
 * Cursor-based pagination for v1 list endpoints.
 *
 * Cursors are opaque base64-JSON tokens encoding the keyset position. The
 * default key is `(created_at, id)`, which is stable across concurrent writes:
 * a row inserted after a cursor was minted appears in a later page, never
 * mid-page. Endpoints that need a different sort key supply their own
 * encoder/decoder pair.
 *
 * Limits are clamped to [1, 100]; default 50.
 *
 * Cursors are NOT signed or encrypted: they reveal only sort-key values that
 * the user could already see from a previous page. Treat them as ephemeral
 * pagination hints, not security tokens.
 */

import { z } from 'zod'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

export interface PaginationParams {
  limit: number
  cursor: string | null
}

/**
 * Parse `?cursor=...&limit=...` from a URL. Returns a normalized
 * { limit, cursor } pair with limit clamped to [1, MAX_LIMIT].
 *
 * Invalid `limit` (non-numeric, negative) falls back to DEFAULT_LIMIT rather
 * than throwing: callers can always re-validate via Zod if strictness is
 * needed.
 */
export function parsePaginationParams(url: URL): PaginationParams {
  const rawLimit = url.searchParams.get('limit')
  const cursor = url.searchParams.get('cursor')

  let limit = DEFAULT_LIMIT
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT)
    }
  }

  return { limit, cursor: cursor && cursor.length > 0 ? cursor : null }
}

/**
 * Schema for query-param validation when a route already uses Zod for inputs.
 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().min(1).optional(),
})

// ─────────────────────────────────────────────────────────────────
// Default (created_at, id) keyset cursor
// ─────────────────────────────────────────────────────────────────

export interface DefaultCursor {
  /** ISO 8601 timestamp of the boundary row's created_at. */
  ts: string
  /** UUID of the boundary row. Disambiguates rows with identical timestamps. */
  id: string
}

/**
 * Encode a (created_at, id) boundary into an opaque cursor string.
 * Returns null when the input is null/undefined so callers can write
 * `next_cursor: encodeDefaultCursor(lastRow)` without a conditional.
 */
export function encodeDefaultCursor(row: { created_at: string; id: string } | null | undefined): string | null {
  if (!row) return null
  const payload: DefaultCursor = { ts: row.created_at, id: row.id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

// Strict format guards: defence-in-depth against tampered cursors that
// could otherwise inject untyped strings into a query's `.gt(field, value)`.
// PostgREST would likely reject these, but validating here keeps the failure
// mode predictable (stale cursor → "start over") rather than 400-ing.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Decode a cursor produced by encodeDefaultCursor. Returns null when the
 * input is missing or malformed: callers should treat null as "start from
 * the beginning" rather than 400-ing on a stale cursor.
 *
 * `ts` must parse as an ISO 8601 timestamp and `id` must be a UUID; anything
 * else is treated as a stale/corrupt cursor and discarded.
 */
export function decodeDefaultCursor(cursor: string | null | undefined): DefaultCursor | null {
  if (!cursor) return null
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as Partial<DefaultCursor>
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null
    if (!ISO_TIMESTAMP.test(parsed.ts)) return null
    if (!UUID.test(parsed.id)) return null
    return { ts: parsed.ts, id: parsed.id }
  } catch {
    return null
  }
}

/**
 * Convenience: given a result page and the requested limit, return the
 * cursor for the *next* page (or null when this was the final page).
 *
 * Convention: the caller fetches `limit + 1` rows, passes the full slice in,
 * and we return either the cursor of row[limit] or null when the page wasn't
 * full. The caller should then trim the slice to `limit` before returning it
 * to the user.
 */
export function nextCursorFromPage<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number,
): string | null {
  if (rows.length <= limit) return null
  return encodeDefaultCursor(rows[limit])
}
