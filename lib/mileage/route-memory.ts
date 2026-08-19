import type { MileageTrip } from '@/types'

/** What matchRoute found for a from/to pair: one-way km and the latest purpose. */
export interface RouteMatch {
  /**
   * One-way distance in km, unrounded (a stored round trip halves to e.g.
   * 21.25) so that the round-trip toggle re-doubles back to the exact stored
   * value. The server rounds to 1 decimal on save, same as the copy flow.
   */
  distance_km: number
  purpose: string
}

/**
 * Prefill bookkeeping for the trip form: which route produced the prefill and
 * the exact strings written into each field. A field entry is '' when that
 * field was not prefilled (or the user has since edited it, which disowns the
 * prefill). Lets the form clear values that are still ours when the route
 * changes, without ever touching user-typed input.
 */
export interface RoutePrefill {
  key: string
  distance_km: string
  purpose: string
}

/** The form fields route prefill reads and writes. */
export interface RoutePrefillFields {
  from_location: string
  to_location: string
  distance_km: string
  purpose: string
}

/**
 * From/To are free text, so matching is normalized: trimmed, lowercased,
 * inner whitespace collapsed. Åäö are significant and kept as-is.
 */
export function normalizeLocation(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Newline can never appear in normalizeLocation output (all whitespace
// collapses to single spaces), so it is a collision-free separator:
// 'a b'->'c' never keys the same as 'a'->'b c'.
const ROUTE_KEY_SEPARATOR = String.fromCharCode(10)

/**
 * Identity of a route for prefill tracking. Null while either endpoint is
 * blank, so half-typed routes never match or hold a prefill.
 */
export function routeKey(from: string, to: string): string | null {
  const fromKey = normalizeLocation(from)
  const toKey = normalizeLocation(to)
  if (!fromKey || !toKey) return null
  return fromKey + ROUTE_KEY_SEPARATOR + toKey
}

function byMostRecent(a: MileageTrip, b: MileageTrip): number {
  if (a.trip_date !== b.trip_date) return a.trip_date < b.trip_date ? 1 : -1
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return 0
}

// matchRoute runs on every from/to keystroke; cache the sorted order per
// trips array so the sort happens once per load, not once per keystroke.
const sortedCache = new WeakMap<MileageTrip[], MileageTrip[]>()

function sortedByMostRecent(trips: MileageTrip[]): MileageTrip[] {
  let sorted = sortedCache.get(trips)
  if (!sorted) {
    sorted = [...trips].sort(byMostRecent)
    sortedCache.set(trips, sorted)
  }
  return sorted
}

/**
 * Distinct location suggestions across both endpoints of earlier trips,
 * most recently used first. Feeds the Från/Till datalists.
 */
export function locationSuggestions(trips: MileageTrip[]): string[] {
  const seen = new Set<string>()
  const suggestions: string[] = []
  for (const trip of sortedByMostRecent(trips)) {
    for (const location of [trip.from_location, trip.to_location]) {
      const key = normalizeLocation(location)
      if (!key || seen.has(key)) continue
      seen.add(key)
      suggestions.push(location.trim())
    }
  }
  return suggestions
}

/**
 * Latest earlier trip with the same from/to pair (direction-sensitive:
 * the return leg can have a different purpose, and km is symmetric anyway).
 * The stored distance always covers the full logged distance, so a stored
 * round trip is halved back to the one-way value the create form expects.
 */
export function matchRoute(
  trips: MileageTrip[],
  from: string,
  to: string
): RouteMatch | null {
  const key = routeKey(from, to)
  if (!key) return null
  const match = sortedByMostRecent(trips).find(
    (trip) => routeKey(trip.from_location, trip.to_location) === key
  )
  if (!match) return null
  return {
    distance_km: match.is_round_trip
      ? Number(match.distance_km) / 2
      : Number(match.distance_km),
    purpose: match.purpose,
  }
}

/**
 * One step of route prefill, run after every from/to edit in create mode.
 * First disowns a stale prefill: when the route no longer matches the one
 * that produced it, fields still holding the exact prefilled strings are
 * cleared (user-edited values are kept). Then, if the pair matches an earlier
 * trip AND this route has not been offered yet, still-empty fields are filled
 * from the latest match. A route is offered at most once: as long as a
 * prefill record exists for the current key (even with every field disowned),
 * it is kept as-is, so a field the user deliberately emptied is never
 * re-filled by a key-preserving keystroke and per-field tracking survives.
 * Pure: returns the new field values and prefill state, mutates nothing.
 */
export function applyRoutePrefill(
  trips: MileageTrip[],
  fields: RoutePrefillFields,
  prefill: RoutePrefill | null
): { distance_km: string; purpose: string; prefill: RoutePrefill | null } {
  const key = routeKey(fields.from_location, fields.to_location)
  let distanceKm = fields.distance_km
  let purpose = fields.purpose
  let nextPrefill = prefill

  if (prefill && prefill.key !== key) {
    if (prefill.distance_km && distanceKm === prefill.distance_km) distanceKm = ''
    if (prefill.purpose && purpose === prefill.purpose) purpose = ''
    nextPrefill = null
  }

  if (key && !nextPrefill) {
    const match = matchRoute(trips, fields.from_location, fields.to_location)
    if (match) {
      const applied: RoutePrefill = { key, distance_km: '', purpose: '' }
      if (distanceKm === '') {
        distanceKm = String(match.distance_km)
        applied.distance_km = distanceKm
      }
      if (purpose === '') {
        purpose = match.purpose
        applied.purpose = purpose
      }
      nextPrefill = applied
    }
  }

  return { distance_km: distanceKm, purpose, prefill: nextPrefill }
}
