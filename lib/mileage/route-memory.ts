import type { MileageTrip } from '@/types'

export interface RouteMatch {
  /** One-way distance in km, rounded to 1 decimal (matches the numeric(10,1) column). */
  distance_km: number
  purpose: string
}

/**
 * From/To are free text, so matching is normalized: trimmed, lowercased,
 * inner whitespace collapsed. Åäö are significant and kept as-is.
 */
export function normalizeLocation(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function byMostRecent(a: MileageTrip, b: MileageTrip): number {
  if (a.trip_date !== b.trip_date) return a.trip_date < b.trip_date ? 1 : -1
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return 0
}

/**
 * Distinct location suggestions across both endpoints of earlier trips,
 * most recently used first. Feeds the Från/Till datalists.
 */
export function locationSuggestions(trips: MileageTrip[]): string[] {
  const seen = new Set<string>()
  const suggestions: string[] = []
  for (const trip of [...trips].sort(byMostRecent)) {
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
  const fromKey = normalizeLocation(from)
  const toKey = normalizeLocation(to)
  if (!fromKey || !toKey) return null
  const match = [...trips]
    .sort(byMostRecent)
    .find(
      (trip) =>
        normalizeLocation(trip.from_location) === fromKey &&
        normalizeLocation(trip.to_location) === toKey
    )
  if (!match) return null
  const oneWayKm = match.is_round_trip ? Number(match.distance_km) / 2 : Number(match.distance_km)
  return {
    distance_km: Math.round(oneWayKm * 10) / 10,
    purpose: match.purpose,
  }
}
