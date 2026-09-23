import { createLogger } from '@/lib/logger'

const log = createLogger('mileage-distance')

/**
 * Driving-distance suggestion for the körjournal trip form, resolved from
 * free OpenStreetMap services: Nominatim (geocoding) + OSRM (routing).
 * Suggestion-only: every failure path resolves to null and the user always
 * confirms or edits the value, so a wrong match can never book itself.
 */
export interface DistanceSuggestion {
  /** One-way driving distance in km, rounded to 1 decimal like stored trips. */
  distance_km: number
  /** What the geocoder actually matched, so the UI can show it for trust. */
  from_label: string
  to_label: string
}

interface GeocodeHit {
  lat: string
  lon: string
  display_name: string
}

export interface DistanceFetchOptions {
  fetchImpl?: typeof fetch
  /** Spacing between live Nominatim calls (usage policy: max 1 req/s). */
  minIntervalMs?: number
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
// FOSSGIS e.V.'s public OSRM instance (the one osm.org itself routes with).
// Unlike router.project-osrm.org it carries no non-commercial restriction;
// its policy asks for max 1 req/s, no heavy usage, a valid User-Agent and
// visible attribution, all of which this module and the UI provide.
const OSRM_URL = 'https://routing.openstreetmap.de/routed-car/route/v1/driving'
// Nominatim's usage policy requires an identifying User-Agent.
const USER_AGENT = 'Accounted korjournal (https://accounted.se)'
const REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_MIN_INTERVAL_MS = 1_100
const HIT_TTL_MS = 24 * 60 * 60 * 1000
// Misses retry sooner: the address may simply not be typed out fully yet.
const MISS_TTL_MS = 10 * 60 * 1000
const CACHE_MAX_ENTRIES = 500

interface CacheEntry<T> {
  value: T
  expires: number
}

const geocodeCache = new Map<string, CacheEntry<GeocodeHit | null>>()
const suggestionCache = new Map<string, CacheEntry<DistanceSuggestion | null>>()

// Newline can never appear in normalizeQuery output (all whitespace collapses
// to single spaces), so it is a collision-free separator between the two
// endpoints; '|' would let 'Kista|Stockholm'->'Uppsala' share a key with
// 'Kista'->'Stockholm|Uppsala'. Same reasoning as route-memory's ROUTE_KEY.
const ROUTE_CACHE_SEPARATOR = String.fromCharCode(10)

export function clearDistanceCachesForTests(): void {
  geocodeCache.clear()
  suggestionCache.clear()
  nominatimNextSlot = 0
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expires < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Maps iterate in insertion order; dropping the first key evicts the oldest.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { value, expires: Date.now() + ttlMs })
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

// In-instance politeness spacing for live Nominatim calls. Serverless
// instances cannot guarantee a global rate, but combined with the
// click-triggered lookup and the 24h caches this keeps a single instance
// well under the 1 req/s policy. The queue is bounded: rather than holding
// request handlers open, a lookup that would wait longer than
// MAX_QUEUE_WAIT_MS bails out (uncached, so a later retry can succeed)
// without reserving a slot.
let nominatimNextSlot = 0
const MAX_QUEUE_WAIT_MS = 3_000

async function waitForNominatimSlot(minIntervalMs: number): Promise<void> {
  const now = Date.now()
  const waitMs = nominatimNextSlot - now
  if (waitMs > MAX_QUEUE_WAIT_MS) throw new Error('geocoding queue saturated')
  nominatimNextSlot = Math.max(now, nominatimNextSlot) + minIntervalMs
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
}

async function geocode(
  query: string,
  fetchImpl: typeof fetch,
  minIntervalMs: number
): Promise<GeocodeHit | null> {
  const key = normalizeQuery(query)
  const cached = cacheGet(geocodeCache, key)
  if (cached) return cached.value

  await waitForNominatimSlot(minIntervalMs)

  const params = new URLSearchParams({ q: query.trim(), format: 'jsonv2', limit: '1' })
  const res = await fetchImpl(`${NOMINATIM_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'sv' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`)

  const body = (await res.json()) as GeocodeHit[]
  const hit = body[0]?.lat && body[0]?.lon ? body[0] : null
  cacheSet(geocodeCache, key, hit, hit ? HIT_TTL_MS : MISS_TTL_MS)
  return hit
}

async function fetchRouteKm(
  from: GeocodeHit,
  to: GeocodeHit,
  fetchImpl: typeof fetch
): Promise<number | null> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`
  const res = await fetchImpl(`${OSRM_URL}/${coords}?overview=false`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`OSRM responded ${res.status}`)

  const body = (await res.json()) as { code?: string; routes?: Array<{ distance?: number }> }
  const meters = body.code === 'Ok' ? body.routes?.[0]?.distance : undefined
  if (typeof meters !== 'number') return null
  const km = Math.round(meters / 100) / 10
  // Guard the ROUNDED value: 30 m rounds to 0.0 km, which the trip form
  // rejects (km must be > 0), so it must never be suggested.
  return km > 0 ? km : null
}

/**
 * Resolve a one-way driving-distance suggestion between two free-text
 * locations. Returns null when either endpoint cannot be geocoded, no route
 * exists, or an upstream call fails: the form simply shows no suggestion.
 */
export async function fetchDistanceSuggestion(
  from: string,
  to: string,
  options: DistanceFetchOptions = {}
): Promise<DistanceSuggestion | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS

  const routeCacheKey = normalizeQuery(from) + ROUTE_CACHE_SEPARATOR + normalizeQuery(to)
  const cached = cacheGet(suggestionCache, routeCacheKey)
  if (cached) return cached.value

  try {
    // Sequential on purpose: Nominatim's policy forbids parallel requests.
    const fromHit = await geocode(from, fetchImpl, minIntervalMs)
    const toHit = fromHit ? await geocode(to, fetchImpl, minIntervalMs) : null
    if (!fromHit || !toHit) {
      cacheSet(suggestionCache, routeCacheKey, null, MISS_TTL_MS)
      return null
    }

    const km = await fetchRouteKm(fromHit, toHit, fetchImpl)
    if (km === null) {
      cacheSet(suggestionCache, routeCacheKey, null, MISS_TTL_MS)
      return null
    }

    const suggestion: DistanceSuggestion = {
      distance_km: km,
      from_label: fromHit.display_name,
      to_label: toHit.display_name,
    }
    cacheSet(suggestionCache, routeCacheKey, suggestion, HIT_TTL_MS)
    return suggestion
  } catch (error) {
    // Upstream hiccups are not cached: the next debounced attempt may succeed.
    log.warn('suggestion lookup failed', { error: String(error) })
    return null
  }
}
