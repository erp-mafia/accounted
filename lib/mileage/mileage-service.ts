import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateMileageTripInput,
  MileagePeriodSummary,
  MileageTrip,
  MileageVehicleType,
} from '@/types'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { loadPayrollConfig, type PayrollConfig } from '@/lib/salary/payroll-config'
import { getLineItemAccount } from '@/lib/salary/account-mapping'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { roundOre } from '@/lib/money'

/**
 * Körjournal service: trip log per Skatteverket documentation requirements
 * and milersättning booking.
 *
 * Rates come from the DB-driven payroll config (salary_payroll_config), never
 * hardcoded. V1 always reimburses at exactly the tax-free schablon, so no
 * taxable excess arises; the 7332 path exists in the salary module for
 * companies that pay above schablon through payroll.
 */

const KM_PER_MIL = 10

/** BAS 7331: skattefria bilersättningar. */
const MILEAGE_TAXFREE_ACCOUNT = getLineItemAccount('mileage_taxfree')

/** Counter accounts a mileage verifikat may credit. */
export const MILEAGE_COUNTER_ACCOUNTS = ['2820', '2893', '1930'] as const
export type MileageCounterAccount = (typeof MILEAGE_COUNTER_ACCOUNTS)[number]

const round2 = roundOre

export function ratePerMil(config: PayrollConfig, vehicleType: MileageVehicleType): number {
  switch (vehicleType) {
    case 'own_car':
      return config.milersattningEgenBil
    case 'company_car_fossil':
      return config.milersattningFormansbilFossil
    case 'company_car_electric':
      return config.milersattningFormansbilEl
  }
}

const VEHICLE_TYPE_LABELS: Record<MileageVehicleType, string> = {
  own_car: 'egen bil',
  company_car_fossil: 'förmånsbil (bensin/diesel)',
  company_car_electric: 'förmånsbil (el)',
}

/**
 * Aggregate trips into per-vehicle-type totals at the schablon rate.
 * Amounts are rounded once per vehicle-type group (cents-integer math),
 * so the group amounts sum exactly to the verifikat total.
 */
export function summarizeTrips(
  trips: Pick<MileageTrip, 'vehicle_type' | 'distance_km'>[],
  config: PayrollConfig
): MileagePeriodSummary[] {
  const groups = new Map<MileageVehicleType, { km: number; count: number }>()
  for (const trip of trips) {
    const group = groups.get(trip.vehicle_type) || { km: 0, count: 0 }
    group.km = round2(group.km + Number(trip.distance_km))
    group.count += 1
    groups.set(trip.vehicle_type, group)
  }

  const summaries: MileagePeriodSummary[] = []
  for (const [vehicleType, group] of groups) {
    const mil = round2(group.km / KM_PER_MIL)
    const rate = ratePerMil(config, vehicleType)
    summaries.push({
      vehicle_type: vehicleType,
      trip_count: group.count,
      total_km: group.km,
      total_mil: mil,
      rate_per_mil: rate,
      amount: round2(mil * rate),
    })
  }
  return summaries.sort((a, b) => a.vehicle_type.localeCompare(b.vehicle_type))
}

export interface ListTripsFilter {
  from?: string
  to?: string
  status?: 'draft' | 'booked'
  employeeId?: string
}

export async function listTrips(
  supabase: SupabaseClient,
  companyId: string,
  filter: ListTripsFilter = {}
): Promise<MileageTrip[]> {
  return fetchAllRows<MileageTrip>(({ from, to }) => {
    let query = supabase
      .from('mileage_trips')
      .select('*')
      .eq('company_id', companyId)
      .order('trip_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to)
    if (filter.from) query = query.gte('trip_date', filter.from)
    if (filter.to) query = query.lte('trip_date', filter.to)
    if (filter.status) query = query.eq('status', filter.status)
    if (filter.employeeId) query = query.eq('employee_id', filter.employeeId)
    return query
  })
}

export async function createTrip(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateMileageTripInput
): Promise<MileageTrip> {
  const { data, error } = await supabase
    .from('mileage_trips')
    .insert({
      company_id: companyId,
      user_id: userId,
      employee_id: input.employee_id || null,
      trip_date: input.trip_date,
      vehicle_type: input.vehicle_type || 'own_car',
      vehicle_registration: input.vehicle_registration?.trim() || null,
      odometer_start: input.odometer_start ?? null,
      odometer_end: input.odometer_end ?? null,
      distance_km: round2(input.distance_km),
      from_location: input.from_location.trim(),
      to_location: input.to_location.trim(),
      purpose: input.purpose.trim(),
      visited: input.visited?.trim() || null,
      is_round_trip: input.is_round_trip ?? false,
      notes: input.notes?.trim() || null,
      created_via: input.created_via || 'manual',
    })
    .select()
    .single()

  if (error || !data) {
    throw new Error(`Failed to create mileage trip: ${error?.message ?? 'no row returned'}`)
  }
  return data as MileageTrip
}

export type BookMileageResult =
  | {
      ok: true
      journalEntryId: string
      voucherNumber: number | null
      voucherSeries: string | null
      tripCount: number
      totalAmount: number
      summaries: MileagePeriodSummary[]
    }
  | {
      ok: false
      code: 'NO_TRIPS' | 'PERIOD_NOT_OPEN' | 'STAMP_FAILED'
      journalEntryId?: string
    }

/**
 * Book all draft trips in [from, to] as one milersättning verifikat:
 * debit 7331 per vehicle type, credit the chosen counter account
 * (2820 skuld till anställda, 2893 avräkning aktieägare, or 1930 when the
 * payout already left the bank). Trips are stamped booked + linked to the
 * verifikat afterwards; the trip rows are the körjournal underlag (7-year
 * retention via DB trigger).
 */
export async function bookMileagePeriod(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  params: {
    from: string
    to: string
    counterAccount: MileageCounterAccount
    entryDate: string
    employeeId?: string
    createdVia?: 'manual' | 'mcp'
  }
): Promise<BookMileageResult> {
  const trips = await listTrips(supabase, companyId, {
    from: params.from,
    to: params.to,
    status: 'draft',
    employeeId: params.employeeId,
  })
  if (trips.length === 0) {
    return { ok: false, code: 'NO_TRIPS' }
  }

  const period = await resolvePeriodStatusForDate(supabase, companyId, params.entryDate)
  if (period.status !== 'open' || !period.period_id) {
    return { ok: false, code: 'PERIOD_NOT_OPEN' }
  }

  const config = await loadPayrollConfig(supabase, new Date(params.to).getFullYear())
  const summaries = summarizeTrips(trips, config)
  const totalAmount = round2(summaries.reduce((sum, s) => sum + s.amount, 0))
  const totalMil = round2(summaries.reduce((sum, s) => sum + s.total_mil, 0))

  const entry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: period.period_id,
    entry_date: params.entryDate,
    description: `Milersättning ${params.from} till ${params.to} (${trips.length} resor, ${totalMil} mil)`,
    source_type: 'manual',
    lines: [
      ...summaries.map((s) => ({
        account_number: MILEAGE_TAXFREE_ACCOUNT,
        debit_amount: s.amount,
        credit_amount: 0,
        line_description: `Milersättning ${VEHICLE_TYPE_LABELS[s.vehicle_type]}: ${s.total_mil} mil × ${s.rate_per_mil} kr`,
      })),
      {
        account_number: params.counterAccount,
        debit_amount: 0,
        credit_amount: totalAmount,
        line_description: 'Milersättning att utbetala',
      },
    ],
  })

  const tripIds = trips.map((t) => t.id)
  const { data: stamped, error: stampError } = await supabase
    .from('mileage_trips')
    .update({ status: 'booked', journal_entry_id: entry.id })
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .in('id', tripIds)
    .select('id')

  if (stampError || !stamped || stamped.length !== tripIds.length) {
    // The verifikat exists and is correct; surface the partial stamp so the
    // caller can warn instead of silently leaving trips re-bookable.
    return { ok: false, code: 'STAMP_FAILED', journalEntryId: entry.id }
  }

  return {
    ok: true,
    journalEntryId: entry.id,
    voucherNumber: entry.voucher_number ?? null,
    voucherSeries: entry.voucher_series ?? null,
    tripCount: trips.length,
    totalAmount,
    summaries,
  }
}

export type PushToSalaryRunResult =
  | { ok: true; tripCount: number; totalAmount: number; summaries: MileagePeriodSummary[] }
  | {
      ok: false
      code: 'NO_TRIPS' | 'RUN_NOT_FOUND' | 'RUN_NOT_EDITABLE' | 'EMPLOYEE_NOT_IN_RUN' | 'STAMP_FAILED'
    }

/**
 * Push the period's draft trips into a draft/review salary run as
 * mileage_taxfree line items (kostnadsersättning: not taxable, no avgifter,
 * not semesterlönegrundande). The salary run's own booking flow then carries
 * the amounts into the verifikat and AGI.
 */
export async function pushMileageToSalaryRun(
  supabase: SupabaseClient,
  companyId: string,
  params: {
    runId: string
    employeeId: string
    from: string
    to: string
    includeUnassigned?: boolean
  }
): Promise<PushToSalaryRunResult> {
  const { data: run } = await supabase
    .from('salary_runs')
    .select('id, status')
    .eq('id', params.runId)
    .eq('company_id', companyId)
    .single()
  if (!run) return { ok: false, code: 'RUN_NOT_FOUND' }
  if (run.status !== 'draft' && run.status !== 'review') {
    return { ok: false, code: 'RUN_NOT_EDITABLE' }
  }

  const { data: sre } = await supabase
    .from('salary_run_employees')
    .select('id')
    .eq('salary_run_id', params.runId)
    .eq('employee_id', params.employeeId)
    .eq('company_id', companyId)
    .single()
  if (!sre) return { ok: false, code: 'EMPLOYEE_NOT_IN_RUN' }

  const all = await listTrips(supabase, companyId, {
    from: params.from,
    to: params.to,
    status: 'draft',
  })
  const includeUnassigned = params.includeUnassigned ?? true
  const trips = all.filter(
    (t) =>
      t.employee_id === params.employeeId || (includeUnassigned && t.employee_id === null)
  )
  if (trips.length === 0) return { ok: false, code: 'NO_TRIPS' }

  const config = await loadPayrollConfig(supabase, new Date(params.to).getFullYear())
  const summaries = summarizeTrips(trips, config)
  const totalAmount = round2(summaries.reduce((sum, s) => sum + s.amount, 0))

  const { error: itemError } = await supabase.from('salary_line_items').insert(
    summaries.map((s, index) => ({
      salary_run_employee_id: sre.id,
      company_id: companyId,
      item_type: 'mileage_taxfree',
      description: `Milersättning ${VEHICLE_TYPE_LABELS[s.vehicle_type]} ${params.from} till ${params.to} (${s.trip_count} resor)`,
      quantity: s.total_mil,
      unit_price: s.rate_per_mil,
      amount: s.amount,
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      account_number: MILEAGE_TAXFREE_ACCOUNT,
      sort_order: 100 + index,
    }))
  )
  if (itemError) {
    throw new Error(`Failed to add mileage line items: ${itemError.message}`)
  }

  const { data: stamped, error: stampError } = await supabase
    .from('mileage_trips')
    .update({ status: 'booked', salary_run_id: params.runId })
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .in(
      'id',
      trips.map((t) => t.id)
    )
    .select('id')

  if (stampError || !stamped || stamped.length !== trips.length) {
    return { ok: false, code: 'STAMP_FAILED' }
  }

  return { ok: true, tripCount: trips.length, totalAmount, summaries }
}
