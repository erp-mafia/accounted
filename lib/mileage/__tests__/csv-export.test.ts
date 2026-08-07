import { describe, expect, it } from 'vitest'
import { mileageTripsToCsv } from '@/lib/mileage/csv-export'
import type { MileageTrip } from '@/types'

function trip(overrides: Partial<MileageTrip>): MileageTrip {
  return {
    id: 'trip-1',
    company_id: 'company-1',
    user_id: 'user-1',
    employee_id: null,
    trip_date: '2026-05-10',
    vehicle_type: 'own_car',
    vehicle_registration: 'ABC123',
    odometer_start: 1000,
    odometer_end: 1032,
    distance_km: 32.3,
    from_location: 'Kontoret',
    to_location: 'Kunden',
    purpose: 'Kundbesök',
    visited: null,
    is_round_trip: false,
    status: 'draft',
    journal_entry_id: null,
    salary_run_id: null,
    notes: null,
    created_via: 'manual',
    created_at: '2026-05-10T00:00:00Z',
    updated_at: '2026-05-10T00:00:00Z',
    ...overrides,
  }
}

describe('mileageTripsToCsv', () => {
  it('starts with a UTF-8 BOM and the Swedish header row', () => {
    const csv = mileageTripsToCsv([])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('Datum;Förare;Fordon;Registreringsnummer')
  })

  it('renders decimal comma, odometer readings and status labels', () => {
    const csv = mileageTripsToCsv([trip({})])
    const row = csv.split('\r\n')[1]
    expect(row).toContain('2026-05-10;;Egen bil;ABC123;1000;1032;32,3;Kontoret;Kunden')
    expect(row).toContain('Utkast')
  })

  it('names the driver for employee-attributed trips', () => {
    const csv = mileageTripsToCsv(
      [trip({ employee_id: 'emp-1' })],
      new Map(),
      new Map([['emp-1', 'Anna Andersson']])
    )
    expect(csv.split('\r\n')[1]).toContain('2026-05-10;Anna Andersson;Egen bil')
  })

  it('neutralizes formula-injection triggers in user text', () => {
    const csv = mileageTripsToCsv([
      trip({ purpose: '=HYPERLINK("http://evil","x")', from_location: '+SUM(A1)', visited: '@cmd' }),
    ])
    const row = csv.split('\r\n')[1]
    expect(row).toContain(`'=HYPERLINK`)
    expect(row).toContain(`'+SUM(A1)`)
    expect(row).toContain(`'@cmd`)
  })

  it('quotes fields containing separators and escapes quotes', () => {
    const csv = mileageTripsToCsv([
      trip({ purpose: 'Möte; leverans', visited: 'Firma "AB"' }),
    ])
    expect(csv).toContain('"Möte; leverans"')
    expect(csv).toContain('"Firma ""AB"""')
  })

  it('maps journal entry ids to voucher labels for booked trips', () => {
    const csv = mileageTripsToCsv(
      [trip({ status: 'booked', journal_entry_id: 'je-1' })],
      new Map([['je-1', 'A42']])
    )
    const row = csv.split('\r\n')[1]
    expect(row).toContain('Bokförd;A42')
  })
})
