import type { MileageTrip } from '@/types'

/**
 * Körjournal CSV export for Skatteverket audit purposes. Column labels are
 * statutory-adjacent Swedish terms and stay Swedish in both locales (same
 * policy as SIE/INK2 exports). Semicolon-separated with a UTF-8 BOM so
 * Swedish Excel opens it correctly.
 */

const HEADERS = [
  'Datum',
  'Förare',
  'Fordon',
  'Registreringsnummer',
  'Mätarställning start',
  'Mätarställning slut',
  'Antal km',
  'Från',
  'Till',
  'Ärende',
  'Besökt (kund/plats)',
  'Tur och retur',
  'Status',
  'Verifikat',
] as const

const VEHICLE_LABELS: Record<MileageTrip['vehicle_type'], string> = {
  own_car: 'Egen bil',
  company_car_fossil: 'Förmånsbil (bensin/diesel)',
  company_car_electric: 'Förmånsbil (el)',
}

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  let text = String(value)
  // Formula-injection guard (OWASP CSV injection): user-entered text starting
  // with a formula trigger would execute when the export opens in Excel.
  // Neutralize with a leading apostrophe; spreadsheet apps hide it.
  if (/^[=+@\t\r-]/.test(text)) {
    text = `'${text}`
  }
  if (/[";\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function mileageTripsToCsv(
  trips: MileageTrip[],
  voucherLabels: Map<string, string> = new Map(),
  driverLabels: Map<string, string> = new Map()
): string {
  const rows = trips.map((trip) =>
    [
      trip.trip_date,
      trip.employee_id ? (driverLabels.get(trip.employee_id) ?? '') : '',
      VEHICLE_LABELS[trip.vehicle_type],
      trip.vehicle_registration,
      trip.odometer_start,
      trip.odometer_end,
      // Swedish decimal comma for Excel.
      String(trip.distance_km).replace('.', ','),
      trip.from_location,
      trip.to_location,
      trip.purpose,
      trip.visited,
      trip.is_round_trip ? 'Ja' : 'Nej',
      trip.status === 'booked' ? 'Bokförd' : 'Utkast',
      trip.journal_entry_id ? (voucherLabels.get(trip.journal_entry_id) ?? '') : '',
    ]
      .map(csvField)
      .join(';')
  )

  return '\uFEFF' + [HEADERS.join(';'), ...rows].join('\r\n') + '\r\n'
}
