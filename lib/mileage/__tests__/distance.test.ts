import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDistanceCachesForTests, fetchDistanceSuggestion } from '../distance'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function geocodeHit(lat: string, lon: string, name: string) {
  return [{ lat, lon, display_name: name }]
}

const OSRM_OK = { code: 'Ok', routes: [{ distance: 47_250 }] }

// Every call passes minIntervalMs: 0 so tests never sleep for the
// Nominatim politeness spacing.
const OPTS = (fetchImpl: typeof fetch) => ({ fetchImpl, minIntervalMs: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  clearDistanceCachesForTests()
})

describe('fetchDistanceSuggestion', () => {
  it('geocodes both endpoints and returns the OSRM distance rounded to 1 decimal', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.87', '14.80', 'Växjö, Sverige')))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.89', '14.55', 'Alvesta, Sverige')))
      .mockResolvedValueOnce(jsonResponse(OSRM_OK))

    const result = await fetchDistanceSuggestion('Växjö', 'Alvesta', OPTS(fetchImpl))

    expect(result).toEqual({
      distance_km: 47.3,
      from_label: 'Växjö, Sverige',
      to_label: 'Alvesta, Sverige',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('nominatim.openstreetmap.org')
    // FOSSGIS instance on purpose: the project-osrm.org demo server is
    // restricted to non-commercial use.
    expect(String(fetchImpl.mock.calls[2][0])).toContain('routing.openstreetmap.de')
    // OSRM wants lon,lat ordering.
    expect(String(fetchImpl.mock.calls[2][0])).toContain('14.80,56.87;14.55,56.89')
  })

  it('returns null and skips the second geocode when the first endpoint has no match', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([]))

    const result = await fetchDistanceSuggestion('hemma', 'Alvesta', OPTS(fetchImpl))

    expect(result).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns null when OSRM finds no route', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.87', '14.80', 'A')))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.89', '14.55', 'B')))
      .mockResolvedValueOnce(jsonResponse({ code: 'NoRoute', routes: [] }))

    expect(await fetchDistanceSuggestion('A', 'B', OPTS(fetchImpl))).toBeNull()
  })

  it('returns null on an upstream failure instead of throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503))

    expect(await fetchDistanceSuggestion('Växjö', 'Alvesta', OPTS(fetchImpl))).toBeNull()
  })

  it('serves repeat lookups from cache without new upstream calls', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.87', '14.80', 'A')))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.89', '14.55', 'B')))
      .mockResolvedValueOnce(jsonResponse(OSRM_OK))

    const first = await fetchDistanceSuggestion('Växjö', 'Alvesta', OPTS(fetchImpl))
    // Same route, differently cased/spaced: normalizes to the same cache key.
    const second = await fetchDistanceSuggestion('  växjö ', 'ALVESTA', OPTS(fetchImpl))

    expect(second).toEqual(first)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('caches a miss so half-typed routes are not re-queried immediately', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]))

    await fetchDistanceSuggestion('hemma', 'jobbet', OPTS(fetchImpl))
    await fetchDistanceSuggestion('hemma', 'jobbet', OPTS(fetchImpl))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not suggest a distance that rounds to 0 km', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.87', '14.80', 'A')))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.87', '14.80', 'B')))
      .mockResolvedValueOnce(jsonResponse({ code: 'Ok', routes: [{ distance: 30 }] }))

    expect(await fetchDistanceSuggestion('Storgatan 1', 'Storgatan 3', OPTS(fetchImpl))).toBeNull()
  })

  it('does not collide cache keys when an address contains the "|" character', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geocodeHit('59.40', '17.94', 'Kista|Stockholm')))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('59.86', '17.64', 'Uppsala')))
      .mockResolvedValueOnce(jsonResponse({ code: 'Ok', routes: [{ distance: 60_000 }] }))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('59.40', '17.94', 'Kista')))
      .mockResolvedValueOnce(jsonResponse(geocodeHit('59.33', '18.06', 'Stockholm|Uppsala')))
      .mockResolvedValueOnce(jsonResponse({ code: 'Ok', routes: [{ distance: 12_000 }] }))

    const a = await fetchDistanceSuggestion('Kista|Stockholm', 'Uppsala', OPTS(fetchImpl))
    // Same '|'-joined text, different route: must NOT be served a's cache.
    const b = await fetchDistanceSuggestion('Kista', 'Stockholm|Uppsala', OPTS(fetchImpl))

    expect(a?.distance_km).toBe(60)
    expect(b?.distance_km).toBe(12)
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })

  it('bails out instead of queueing when the politeness wait exceeds the bound', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(geocodeHit('56.87', '14.80', 'Växjö, Sverige')))
      .mockResolvedValueOnce(jsonResponse(OSRM_OK))

    // 'Växjö'/'växjö' share a geocode cache entry, so the first lookup makes
    // one live Nominatim call and reserves one 10s slot. The next uncached
    // route would have to wait far past MAX_QUEUE_WAIT_MS and must bail to
    // null without any upstream call instead of holding the handler open.
    const first = await fetchDistanceSuggestion('Växjö', 'växjö', {
      fetchImpl,
      minIntervalMs: 10_000,
    })
    const second = await fetchDistanceSuggestion('Ljungby', 'Markaryd', {
      fetchImpl,
      minIntervalMs: 10_000,
    })

    expect(first?.distance_km).toBe(47.3)
    expect(second).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
