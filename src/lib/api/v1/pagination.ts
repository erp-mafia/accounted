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
import { UUID_RE as UUID } from '@/lib/invariants/uuid'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/**
 * The pagination query parameters as the endpoint registry documents them
 * (spread into a list route's `request.query`). parsePaginationParams stays
 * the parser: it is deliberately lenient, so this schema describes the
 * contract rather than validating requests.
 */
export const PaginationQueryShape = {
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor from the previous page\'s meta.next_cursor. Omit for the first page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Page size, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}). Larger values are clamped to ${MAX_LIMIT}.`),
}

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

/**
 * Decode a cursor produced by encodeDefaultCursor. Returns null when the
 * input is missing or malformed: callers should treat null as "start from
 * the beginning" rather than 400-ing on a stale cursor.
 *
 * `ts` must parse as an ISO 8601 timestamp and `id` must be a UUID; anything
 * else is treated as a stale/corrupt cursor and discarded.
 */
export function decodeDefaultCursor(cursor: string | null | undefined): DefaultCursor | null {
  const parsed = readCursorPayload(cursor)
  // A change-feed cursor (encodeChangeCursor) carries an updated_at, not a
  // created_at: applied to the default keyset it would skip rows.
  if (!parsed || parsed.k !== undefined) return null
  return keysetBoundary(parsed)
}

/**
 * Parse a cursor's base64url JSON payload. Returns null for anything that is
 * not a JSON object. The catch is deliberate and needs no trace: a cursor is
 * client input, and a stale or tampered one means "start over" (documented on
 * every list endpoint), never an error worth logging.
 */
function readCursorPayload(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The (ts, id) boundary of a decoded payload, or null unless both are well-formed. */
function keysetBoundary(parsed: Record<string, unknown>): DefaultCursor | null {
  const { ts, id } = parsed
  if (typeof ts !== 'string' || typeof id !== 'string') return null
  if (!ISO_TIMESTAMP.test(ts)) return null
  if (!UUID.test(id)) return null
  return { ts, id }
}

/**
 * Convenience: given a result page and the requested limit, return the
 * cursor for the *next* page (or null when this was the final page).
 *
 * Convention: the caller fetches `limit + 1` rows, passes the full slice in,
 * and we return either the cursor of the LAST ROW OF THE TRIMMED PAGE
 * (rows[limit - 1]) or null when the page wasn't full. The caller should then
 * trim the slice to `limit` before returning it to the user.
 *
 * Contract: the cursor marks the last row already returned; every v1 route's
 * keyset predicate is strictly greater/less than the cursor, so encoding
 * rows[limit] (the first row of the NEXT page) would skip that row at every
 * page boundary.
 */
export function nextCursorFromPage<T extends { created_at: string; id: string }>(
  rows: T[],
  limit: number,
): string | null {
  if (rows.length <= limit) return null
  return encodeDefaultCursor(rows[limit - 1])
}

// ─────────────────────────────────────────────────────────────────
// Change feed: ?updated_since with an (updated_at, id) keyset cursor
// ─────────────────────────────────────────────────────────────────
//
// The created_at cursor answers "what rows exist"; it never resurfaces a row
// whose state changed after it was created (an invoice paid, a customer
// edited). A webhook says that something changed, but only for the events
// that exist, and only while every delivery lands. ?updated_since lets an
// integration ask the database instead: every row whose updated_at is at or
// after the timestamp, oldest change first, so the last row of the last page
// is the next watermark. Only tables whose updated_at is kept by the
// update_updated_at_column() trigger may offer it; a column the application
// sets by hand can lag the row.

export const UpdatedSinceQueryShape = {
  updated_since: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO 8601 timestamp. Return only rows created or changed at or after it, ordered by updated_at then id (oldest change first) instead of the default order. Store the updated_at of the last row you received and pass it back, minus a safety margin of a few minutes, then drop rows you already hold with the same id and updated_at.',
    ),
}

const UpdatedSinceSchema = UpdatedSinceQueryShape.updated_since

/**
 * Parse ?updated_since. Unlike cursor and limit this is strict: a malformed
 * timestamp is a 400, because silently ignoring it would return the default
 * order and the caller would store a wrong watermark.
 */
export function parseUpdatedSince(
  url: URL,
): { ok: true; value: string | null } | { ok: false; error: z.ZodError } {
  const raw = url.searchParams.get('updated_since')
  if (raw === null || raw === '') return { ok: true, value: null }
  const parsed = z.object({ updated_since: UpdatedSinceSchema }).safeParse({ updated_since: raw })
  if (!parsed.success) return { ok: false, error: parsed.error }
  return { ok: true, value: parsed.data.updated_since ?? null }
}

interface ChangeCursorPayload {
  /** Marks a change-feed cursor so a created_at cursor is never misread as one. */
  k: 'u'
  ts: string
  id: string
}

/** Encode an (updated_at, id) boundary into an opaque change-feed cursor. */
export function encodeChangeCursor(row: { updated_at: string; id: string } | null | undefined): string | null {
  if (!row) return null
  const payload: ChangeCursorPayload = { k: 'u', ts: row.updated_at, id: row.id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode a cursor produced by encodeChangeCursor. A missing, malformed or
 * created_at cursor returns null: start from the updated_since boundary.
 */
export function decodeChangeCursor(cursor: string | null | undefined): DefaultCursor | null {
  const parsed = readCursorPayload(cursor)
  if (!parsed || parsed.k !== 'u') return null
  return keysetBoundary(parsed)
}

/** The query-builder methods applyListPage uses. */
interface KeysetQuery<Q> {
  gte(column: string, value: string): Q
  or(filters: string): Q
  order(column: string, options: { ascending: boolean }): Q
}

export interface ListPageOptions {
  /** parseUpdatedSince's value: non-null switches the list to the change feed. */
  updatedSince: string | null
  /** The raw ?cursor (parsePaginationParams). */
  cursor: string | null
  /** The list's default created_at direction; id always breaks ties ascending. */
  createdAscending: boolean
}

/**
 * Apply the keyset predicate and order of one page to a list query that has
 * neither yet: (created_at, id) by default, or (updated_at ASC, id ASC) from
 * the watermark when ?updated_since is set. The caller applies .limit(n + 1)
 * and builds the next cursor with nextListCursor.
 */
export function applyListPage<Q extends KeysetQuery<Q>>(query: Q, options: ListPageOptions): Q {
  if (options.updatedSince) {
    let q = query.gte('updated_at', options.updatedSince)
    const boundary = decodeChangeCursor(options.cursor)
    if (boundary) {
      q = q.or(`updated_at.gt.${boundary.ts},and(updated_at.eq.${boundary.ts},id.gt.${boundary.id})`)
    }
    return q.order('updated_at', { ascending: true }).order('id', { ascending: true })
  }
  let q = query
  const boundary = decodeDefaultCursor(options.cursor)
  if (boundary) {
    // created_at moves in the list's direction; id breaks ties ascending.
    const op = options.createdAscending ? 'gt' : 'lt'
    q = q.or(`created_at.${op}.${boundary.ts},and(created_at.eq.${boundary.ts},id.gt.${boundary.id})`)
  }
  return q.order('created_at', { ascending: options.createdAscending }).order('id', { ascending: true })
}

/** The next page's cursor for the last row returned, in the same mode as applyListPage. */
export function nextListCursor(
  last: { created_at: string; updated_at: string; id: string },
  updatedSince: string | null,
): string | null {
  return updatedSince ? encodeChangeCursor(last) : encodeDefaultCursor(last)
}
