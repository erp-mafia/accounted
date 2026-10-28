/**
 * Körjournal (mileage trip log) operations: list the trips and log a new
 * one. A trip is underlag, not a verifikat: it stays a draft until the
 * period is booked as milersättning (gnubok_book_mileage_period) or pushed
 * to a salary run. Rules live in lib/mileage/mileage-service.ts.
 *
 * No `mcp` binding yet: the hand-written gnubok_list_mileage_trips and
 * gnubok_log_mileage_trip tools in the MCP extension still serve that door;
 * moving them onto these operations is a separate change.
 */
import { z } from 'zod'
import { CreateMileageTripSchema } from '@/lib/api/schemas'
import { createTrip, listTrips, ratePerMil } from '@/lib/mileage/mileage-service'
import { loadPayrollConfig } from '@/lib/salary/payroll-config'
import { roundOre } from '@/lib/money'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import type { MileageTrip } from '@/types'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const VEHICLE_TYPE = z.enum(['own_car', 'company_car_fossil', 'company_car_electric'])

const MileageTripOut = z.object({
  mileage_trip_id: z.string().uuid(),
  trip_date: z.string(),
  vehicle_type: VEHICLE_TYPE.describe('own_car = egen bil; company_car_fossil / company_car_electric = förmånsbil.'),
  vehicle_registration: z.string().nullable(),
  odometer_start: z.number().int().nullable().describe('Odometer at departure, in km.'),
  odometer_end: z.number().int().nullable().describe('Odometer at arrival, in km.'),
  distance_km: z.number().describe('Distance in km, stored with one decimal.'),
  from_location: z.string(),
  to_location: z.string(),
  purpose: z.string().describe('Business purpose (ärende).'),
  visited: z.string().nullable().describe('Who or which company was visited.'),
  is_round_trip: z.boolean().describe('True when distance_km already covers the return leg.'),
  employee_id: z.string().uuid().nullable().describe('The employee who drove, or null for the owner.'),
  status: z.enum(['draft', 'booked']).describe('draft = not yet booked as milersättning; booked = in a verifikat or salary run.'),
  journal_entry_id: z.string().uuid().nullable().describe('The milersättning verifikat, once booked.'),
  created_at: z.string(),
})
type MileageTripOut = z.infer<typeof MileageTripOut>

function toPublicTrip(trip: MileageTrip): MileageTripOut {
  return {
    mileage_trip_id: trip.id,
    trip_date: trip.trip_date,
    vehicle_type: trip.vehicle_type,
    vehicle_registration: trip.vehicle_registration,
    odometer_start: trip.odometer_start == null ? null : Number(trip.odometer_start),
    odometer_end: trip.odometer_end == null ? null : Number(trip.odometer_end),
    // numeric(10,1) arrives from PostgREST as a string.
    distance_km: Number(trip.distance_km),
    from_location: trip.from_location,
    to_location: trip.to_location,
    purpose: trip.purpose,
    visited: trip.visited,
    is_round_trip: trip.is_round_trip,
    employee_id: trip.employee_id,
    status: trip.status,
    journal_entry_id: trip.journal_entry_id,
    created_at: trip.created_at,
  }
}

const sumKm = (trips: MileageTripOut[]) => roundOre(trips.reduce((sum, t) => sum + t.distance_km, 0))

const EXAMPLE_TRIP = {
  mileage_trip_id: '3b7e…',
  trip_date: '2026-10-14',
  vehicle_type: 'own_car',
  vehicle_registration: null,
  odometer_start: 48210,
  odometer_end: 48352,
  distance_km: 142,
  from_location: 'Kontoret, Uppsala',
  to_location: 'Kund AB, Stockholm',
  purpose: 'Kundmöte, uppstart av projekt',
  visited: 'Kund AB',
  is_round_trip: true,
  employee_id: null,
  status: 'draft',
  journal_entry_id: null,
  created_at: '2026-10-14T16:02:00Z',
}

const ISO_DATE = saneIsoDateSchema

export const mileageTripsList = defineOperation({
  id: 'mileage-trips.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List körjournal trips (mileage log) with total and unbooked distance.',
    description:
      'Returns the company\'s körjournal trips, newest trip_date first, each with route, distance, purpose, vehicle and status (draft = not yet booked as milersättning, booked = in a verifikat or a salary run). Filter by trip_date range (from, to inclusive), status or employee_id. total_km sums every listed trip; draft_km sums the unbooked ones. Not paginated: every matching trip is returned.',
    useWhen:
      'You show the trip log, check what is still unbooked before booking milersättning for a period, or need the underlag behind a milersättning verifikat.',
    doNotUseFor:
      'Expense claims (GET /expense-claims) or the milersättning amounts in a salary run (the salary-runs endpoints).',
    pitfalls: [
      'distance_km is kilometres; milersättning is paid per mil (10 km) at the schablon rate for the vehicle type.',
      'Trips without employee_id are the owner\'s; filtering on employee_id leaves them out.',
      'from and to filter on trip_date, not on when the trip was logged.',
    ],
    example: {
      request: { from: '2026-10-01', to: '2026-10-31', status: 'draft' },
      response: { data: { mileage_trips: [EXAMPLE_TRIP], total_km: 142, draft_km: 142 }, meta: META },
    },
  },
  input: z.object({
    from: ISO_DATE.optional().describe('First trip_date to include (YYYY-MM-DD).'),
    to: ISO_DATE.optional().describe('Last trip_date to include (YYYY-MM-DD).'),
    status: z.enum(['draft', 'booked']).optional().describe('draft = not yet booked, booked = booked.'),
    employee_id: z.string().uuid().optional().describe('Only this employee\'s trips.'),
  }),
  output: z.object({
    mileage_trips: z.array(MileageTripOut),
    total_km: z.number().describe('Sum of distance_km over the listed trips.'),
    draft_km: z.number().describe('Sum of distance_km over the listed trips still in draft.'),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/mileage-trips' },
  run: async (ctx, input) => {
    const rows = await listTrips(ctx.supabase, ctx.companyId, {
      from: input.from,
      to: input.to,
      status: input.status,
      employeeId: input.employee_id,
    })
    const trips = rows.map(toPublicTrip)
    return {
      ok: true,
      data: {
        mileage_trips: trips,
        total_km: sumKm(trips),
        draft_km: sumKm(trips.filter((t) => t.status === 'draft')),
      },
    }
  },
})

type CreateInput = z.infer<typeof CreateMileageTripSchema>

/**
 * The tenancy check createTrip would otherwise throw as a plain Error (which
 * reaches a machine caller as a 500), answered as a registry code. It runs on
 * a dry run too, which writes nothing and so never reaches createTrip. The
 * förmånsbil registration rule needs no check here: the input schema refuses
 * it as a VALIDATION_ERROR before run() is reached.
 */
async function checkTrip(
  ctx: OperationContext,
  input: CreateInput,
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  if (input.employee_id) {
    // The FK on employee_id is not company-scoped, so tenancy is checked here.
    const { data: employee } = await ctx.supabase
      .from('employees')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('id', input.employee_id)
      .maybeSingle()
    if (!employee) return { ok: false, code: 'EMPLOYEE_NOT_FOUND' }
  }
  return null
}

/** The schablon allowance the trip would add when booked; null when the year's rates are missing. */
async function estimateAllowance(ctx: OperationContext, input: CreateInput) {
  try {
    const config = await loadPayrollConfig(ctx.supabase, Number(input.trip_date.slice(0, 4)))
    const rate = ratePerMil(config, input.vehicle_type)
    return { rate_per_mil: rate, estimated_allowance_sek: roundOre((input.distance_km / 10) * rate) }
  } catch {
    return { rate_per_mil: null, estimated_allowance_sek: null }
  }
}

export const mileageTripsCreate = defineOperation({
  id: 'mileage-trips.create',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Log a körjournal trip (mileage log entry).',
    description:
      'Records one business trip with what Skatteverket expects of a körjournal: date, start and destination, distance, purpose (ärende) and who was visited, plus odometer readings and the vehicle. The trip is saved as a draft; nothing is booked. Milersättning is booked later for a whole period at the tax-free schablon rate for the vehicle type. A förmånsbil trip must name the vehicle (vehicle_registration). Idempotent. Dry-runnable: the preview carries the schablon rate and the allowance the trip would add.',
    useWhen: 'A trip was driven in a private car or a förmånsbil for the business and should go into the körjournal.',
    doNotUseFor:
      'Fuel or parking receipts (expense claims or supplier invoices), or booking milersättning for a period (not on v1 yet).',
    pitfalls: [
      'distance_km is kilometres, not mil; it is stored rounded to one decimal.',
      'vehicle_type company_car_fossil or company_car_electric without vehicle_registration returns 400 VALIDATION_ERROR.',
      'is_round_trip only labels the trip: distance_km must already include the return leg.',
      'An employee_id from another company returns 404 EMPLOYEE_NOT_FOUND.',
      'odometer_end must be greater than odometer_start when both are sent.',
    ],
    example: {
      request: {
        trip_date: '2026-10-14',
        distance_km: 142,
        from_location: 'Kontoret, Uppsala',
        to_location: 'Kund AB, Stockholm',
        purpose: 'Kundmöte, uppstart av projekt',
        visited: 'Kund AB',
        is_round_trip: true,
        odometer_start: 48210,
        odometer_end: 48352,
      },
      response: { data: EXAMPLE_TRIP, meta: META },
    },
  },
  input: CreateMileageTripSchema,
  output: MileageTripOut,
  errorCodes: ['EMPLOYEE_NOT_FOUND'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/mileage-trips' },
  run: async (ctx, input, { dryRun }) => {
    const refused = await checkTrip(ctx, input)
    if (refused) return refused
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          trip_date: input.trip_date,
          vehicle_type: input.vehicle_type,
          vehicle_registration: input.vehicle_registration?.trim() || null,
          odometer_start: input.odometer_start ?? null,
          odometer_end: input.odometer_end ?? null,
          distance_km: Math.round(input.distance_km * 10) / 10,
          from_location: input.from_location,
          to_location: input.to_location,
          purpose: input.purpose,
          visited: input.visited?.trim() || null,
          is_round_trip: input.is_round_trip,
          employee_id: input.employee_id ?? null,
          status: 'draft',
          ...(await estimateAllowance(ctx, input)),
        },
      }
    }
    const trip = await createTrip(ctx.supabase, ctx.companyId, ctx.userId, input)
    return { ok: true, created: true, data: toPublicTrip(trip) }
  },
})
