/**
 * The current API version date.
 *
 * Echoed in every response's `meta.api_version` and stamped as the
 * `Gnubok-Version` response header (with-api-v1.ts). A `Gnubok-Version`
 * REQUEST header is reserved for future date-pinned breaking changes: nothing
 * reads it today, every request gets the current version.
 *
 * Bump this only for a breaking change inside v1 (additive changes never bump
 * it); that is also when request pinning gets wired so integrators can keep
 * the older shape.
 */
export const API_V1_VERSION = '2026-05-12'

export const API_V1_VERSION_HEADER = 'Gnubok-Version'
