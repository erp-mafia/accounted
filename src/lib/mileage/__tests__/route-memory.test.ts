import { describe, expect, it } from 'vitest'
import {
  applyRoutePrefill,
  locationSuggestions,
  matchRoute,
  normalizeLocation,
  routeKey,
} from '../route-memory'
import type { MileageTrip } from '@/types'

function makeTrip(overrides: Partial<MileageTrip> = {}): MileageTrip {
  return {
    id: 'trip-1',
    company_id: 'company-1',
    user_id: 'user-1',
    employee_id: null,
    trip_date: '2026-08-10',
    vehicle_type: 'own_car',
    vehicle_registration: null,
    odometer_start: null,
    odometer_end: null,
    distance_km: 42,
    from_location: 'Kontoret',
    to_location: 'Kunden AB',
    purpose: 'Kundbesök',
    visited: null,
    is_round_trip: false,
    status: 'draft',
    journal_entry_id: null,
    salary_run_id: null,
    notes: null,
    created_via: 'manual',
    created_at: '2026-08-10T08:00:00Z',
    updated_at: '2026-08-10T08:00:00Z',
    ...overrides,
  }
}

describe('normalizeLocation', () => {
  it('trims, lowercases, and collapses inner whitespace', () => {
    expect(normalizeLocation('  Kontoret   Söder  ')).toBe('kontoret söder')
  })

  it('keeps åäö significant', () => {
    expect(normalizeLocation('Växjö')).toBe('växjö')
    expect(normalizeLocation('Vaxjo')).not.toBe(normalizeLocation('Växjö'))
  })
})

describe('matchRoute', () => {
  it('returns the distance and purpose of a matching earlier trip', () => {
    const trips = [makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' })]
    expect(matchRoute(trips, 'Kontoret', 'Kunden AB')).toEqual({
      distance_km: 42.5,
      purpose: 'Kundbesök',
    })
  })

  it('matches case- and whitespace-insensitively', () => {
    const trips = [makeTrip()]
    expect(matchRoute(trips, '  kontoret ', 'KUNDEN   ab')).not.toBeNull()
  })

  it('is direction-sensitive', () => {
    const trips = [makeTrip()]
    expect(matchRoute(trips, 'Kunden AB', 'Kontoret')).toBeNull()
  })

  it('halves a stored round trip back to the one-way distance', () => {
    const trips = [makeTrip({ distance_km: 85, is_round_trip: true })]
    expect(matchRoute(trips, 'Kontoret', 'Kunden AB')?.distance_km).toBe(42.5)
  })

  it('returns the unrounded half so re-doubling restores the exact stored km', () => {
    const trips = [makeTrip({ distance_km: 42.5, is_round_trip: true })]
    expect(matchRoute(trips, 'Kontoret', 'Kunden AB')?.distance_km).toBe(21.25)
  })

  it('prefers the most recent trip by date, then created_at', () => {
    const trips = [
      makeTrip({ id: 'old', trip_date: '2026-08-01', distance_km: 40 }),
      makeTrip({ id: 'new', trip_date: '2026-08-12', distance_km: 44 }),
      makeTrip({
        id: 'same-day-later',
        trip_date: '2026-08-12',
        created_at: '2026-08-12T15:00:00Z',
        distance_km: 45,
      }),
    ]
    expect(matchRoute(trips, 'Kontoret', 'Kunden AB')?.distance_km).toBe(45)
  })

  it('returns null when either endpoint is blank or nothing matches', () => {
    const trips = [makeTrip()]
    expect(matchRoute(trips, '', 'Kunden AB')).toBeNull()
    expect(matchRoute(trips, 'Kontoret', '   ')).toBeNull()
    expect(matchRoute(trips, 'Kontoret', 'Annan kund')).toBeNull()
  })

  it('does not mutate the input order', () => {
    const trips = [
      makeTrip({ id: 'a', trip_date: '2026-08-01' }),
      makeTrip({ id: 'b', trip_date: '2026-08-12' }),
    ]
    matchRoute(trips, 'Kontoret', 'Kunden AB')
    expect(trips.map((trip) => trip.id)).toEqual(['a', 'b'])
  })
})

describe('routeKey', () => {
  it('is null while either endpoint is blank', () => {
    expect(routeKey('', 'Kunden AB')).toBeNull()
    expect(routeKey('Kontoret', '  ')).toBeNull()
  })

  it('normalizes both endpoints', () => {
    expect(routeKey(' Kontoret ', 'KUNDEN  ab')).toBe(routeKey('kontoret', 'Kunden AB'))
  })

  it('never collides ambiguous concatenations', () => {
    expect(routeKey('a b', 'c')).not.toBe(routeKey('a', 'b c'))
  })
})

describe('applyRoutePrefill', () => {
  const fields = (overrides: Partial<Parameters<typeof applyRoutePrefill>[1]> = {}) => ({
    from_location: 'Kontoret',
    to_location: 'Kunden AB',
    distance_km: '',
    purpose: '',
    ...overrides,
  })

  it('fills empty km and purpose on a match and records the prefill', () => {
    const trips = [makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' })]
    const result = applyRoutePrefill(trips, fields(), null)
    expect(result.distance_km).toBe('42.5')
    expect(result.purpose).toBe('Kundbesök')
    expect(result.prefill).toEqual({
      key: routeKey('Kontoret', 'Kunden AB'),
      distance_km: '42.5',
      purpose: 'Kundbesök',
    })
  })

  it('clears prefilled values when typing past the match onto a new route', () => {
    // Skeptic scenario: "Kunden AB" matched and prefilled; user keeps typing
    // " Syd". The stale km and purpose must not survive onto the new route.
    const trips = [makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' })]
    const matched = applyRoutePrefill(trips, fields(), null)
    const result = applyRoutePrefill(
      trips,
      fields({
        to_location: 'Kunden AB Syd',
        distance_km: matched.distance_km,
        purpose: matched.purpose,
      }),
      matched.prefill
    )
    expect(result.distance_km).toBe('')
    expect(result.purpose).toBe('')
    expect(result.prefill).toBeNull()
  })

  it('re-derives the prefill when switching to a different known route', () => {
    // Skeptic scenario: Kontoret->Kunden AB prefilled 42.5; switching Fran to
    // Lagret must swap to that route's latest km, not keep the stale 42.5.
    const trips = [
      makeTrip({ id: 'kontoret', distance_km: 42.5, purpose: 'Kundbesök' }),
      makeTrip({
        id: 'lagret',
        from_location: 'Lagret',
        distance_km: 80,
        purpose: 'Leverans',
        trip_date: '2026-08-01',
      }),
    ]
    const matched = applyRoutePrefill(trips, fields(), null)
    const result = applyRoutePrefill(
      trips,
      fields({
        from_location: 'Lagret',
        distance_km: matched.distance_km,
        purpose: matched.purpose,
      }),
      matched.prefill
    )
    expect(result.distance_km).toBe('80')
    expect(result.purpose).toBe('Leverans')
    expect(result.prefill?.key).toBe(routeKey('Lagret', 'Kunden AB'))
  })

  it('keeps user-typed values when the route changes', () => {
    const trips = [makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' })]
    const matched = applyRoutePrefill(trips, fields(), null)
    // User overwrote the km but left the prefilled purpose in place.
    const result = applyRoutePrefill(
      trips,
      fields({
        to_location: 'Annan kund',
        distance_km: '55',
        purpose: matched.purpose,
      }),
      matched.prefill
    )
    expect(result.distance_km).toBe('55')
    expect(result.purpose).toBe('')
    expect(result.prefill).toBeNull()
  })

  it('does not refill a field the user has disowned on the same route', () => {
    const trips = [makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' })]
    // The page clears the field's prefill entry on manual edits; a later
    // route keystroke must not clear the user's value as stale.
    const result = applyRoutePrefill(
      trips,
      fields({ distance_km: '50', purpose: 'Kundbesök' }),
      { key: routeKey('Kontoret', 'Kunden AB')!, distance_km: '', purpose: 'Kundbesök' }
    )
    expect(result.distance_km).toBe('50')
    expect(result.purpose).toBe('Kundbesök')
  })

  it('keeps the other field tracked when one field is disowned on the same key', () => {
    // Skeptic cycle-2 scenario: both fields prefill, user empties purpose
    // (page disowns it), then a key-preserving keystroke (trailing space).
    // The emptied purpose must stay empty and the km tracking must survive,
    // so a later route switch still clears the machine-written km.
    const trips = [
      makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' }),
      makeTrip({
        id: 'lagret',
        from_location: 'Lagret',
        distance_km: 80,
        purpose: 'Leverans',
        trip_date: '2026-08-01',
      }),
    ]
    const matched = applyRoutePrefill(trips, fields(), null)
    const disowned = { ...matched.prefill!, purpose: '' }
    const sameKey = applyRoutePrefill(
      trips,
      fields({ to_location: 'Kunden AB ', distance_km: matched.distance_km, purpose: '' }),
      disowned
    )
    expect(sameKey.purpose).toBe('')
    expect(sameKey.distance_km).toBe(matched.distance_km)
    expect(sameKey.prefill).toEqual(disowned)
    const switched = applyRoutePrefill(
      trips,
      fields({ from_location: 'Lagret', distance_km: sameKey.distance_km, purpose: '' }),
      sameKey.prefill
    )
    expect(switched.distance_km).toBe('80')
    expect(switched.purpose).toBe('Leverans')
  })

  it('offers a route at most once: emptied fields are not re-filled on the same key', () => {
    const trips = [makeTrip({ distance_km: 42.5, purpose: 'Kundbesök' })]
    const matched = applyRoutePrefill(trips, fields(), null)
    // User empties both fields; the page keeps the marker with both entries ''.
    const marker = { key: matched.prefill!.key, distance_km: '', purpose: '' }
    const result = applyRoutePrefill(
      trips,
      fields({ to_location: 'Kunden AB ', distance_km: '', purpose: '' }),
      marker
    )
    expect(result.distance_km).toBe('')
    expect(result.purpose).toBe('')
    expect(result.prefill).toEqual(marker)
  })

  it('is a no-op without a match or an existing prefill', () => {
    const result = applyRoutePrefill([], fields({ distance_km: '12', purpose: 'Möte' }), null)
    expect(result).toEqual({ distance_km: '12', purpose: 'Möte', prefill: null })
  })
})

describe('locationSuggestions', () => {
  it('returns distinct trimmed locations from both endpoints, most recent first', () => {
    const trips = [
      makeTrip({
        id: 'old',
        trip_date: '2026-08-01',
        from_location: 'Lagret',
        to_location: 'Kunden AB',
      }),
      makeTrip({
        id: 'new',
        trip_date: '2026-08-12',
        from_location: ' Kontoret ',
        to_location: 'kunden ab',
      }),
    ]
    expect(locationSuggestions(trips)).toEqual(['Kontoret', 'kunden ab', 'Lagret'])
  })

  it('returns an empty list for no trips', () => {
    expect(locationSuggestions([])).toEqual([])
  })
})
