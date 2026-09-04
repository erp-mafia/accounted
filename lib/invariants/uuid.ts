/**
 * UUID shape, as stored in every `id` column. Anchored and case-insensitive;
 * version/variant nibbles are NOT checked (Postgres accepts any hex layout, and
 * fixtures use non-RFC ids). Consumers use it as an injection guard before
 * interpolating a server-resolved id into a PostgREST filter, or to validate a
 * route parameter before hitting the database.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
