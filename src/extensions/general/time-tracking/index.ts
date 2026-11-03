import type { Extension } from '@/lib/extensions/types'
import { timeTrackingApiRoutes } from './api-routes'

/**
 * Time tracking extension (tidredovisning)
 *
 * Hours per consultant, customer, project (SIE dimension 6 code) and
 * activity code, stored in time_entries. Consultants, activity codes with
 * hourly rates, and links from imported customer codes to Accounted
 * customers live in extension settings.
 *
 * Imports workbooks shaped like the Numbers "Projektredovisning" template
 * (Transaktioner, Medarbetare, Kunder, Arbetskoder), idempotently per row.
 * Produces a per-customer, per-month summary and a CSV fakturaunderlag.
 * Nothing is booked or invoiced from here: invoices are created in the
 * invoice editor and the hours are then marked as invoiced against them.
 */
export const timeTrackingExtension: Extension = {
  id: 'time-tracking',
  name: 'Tidredovisning',
  version: '1.0.0',
  sector: 'general',
  apiRoutes: timeTrackingApiRoutes,
}

export default timeTrackingExtension
