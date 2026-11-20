/**
 * A trip's distance as mileage_trips.distance_km (numeric(10,1),
 * CHECK > 0) stores it. Client-safe (no server imports): the request schemas
 * refuse a distance that would store as zero, and the service and the v1
 * preview store and show the same value.
 */

/** The distance in km rounded to the one decimal the column keeps. */
export function storedDistanceKm(km: number): number {
  return Math.round(km * 10) / 10
}

/** Does the distance survive the column's rounding as more than zero? */
export function isStorableDistanceKm(km: number): boolean {
  return storedDistanceKm(km) > 0
}
