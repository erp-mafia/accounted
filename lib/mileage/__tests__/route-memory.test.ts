import { describe, expect, it } from 'vitest'
import { locationSuggestions, matchRoute, normalizeLocation } from '../route-memory'
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

  it('rounds the halved distance to 1 decimal', () => {
    const trips = [makeTrip({ distance_km: 42.5, is_round_trip: true })]
    expect(matchRoute(trips, 'Kontoret', 'Kunden AB')?.distance_km).toBe(21.3)
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
