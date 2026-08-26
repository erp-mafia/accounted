/**
 * Semesterberedning + semesterårsavslut (payroll gap-closure 3.3).
 *
 * ONE workflow, two phases on the same year boundary:
 *
 *   Beredning (days): per employee, roll the closing year's balances into
 *   the next vacation year. Only days above the 20-day must-take floor are
 *   saveable (Semesterlagen 18 §); saved days expire after 5 years and move
 *   to forced_payout_days (paid out as semesterersättning via a normal
 *   salary run, never booked here). Untaken days at or below the floor are
 *   FLAGGED for manual handling, not auto-saved.
 *
 *   Årsavslut (SEK): reconcile the day-valued semesterlöneskuld against the
 *   BOOKED 2920/2940 balances (per-run accruals never relieve 2920 when
 *   vacation is taken, so drift accumulates by design) and post ONE
 *   adjustment verifikation via the bookkeeping engine when |drift| > 1 kr.
 *
 * Day valuation (BFNAR 2016:10 per-employee, simplified and shown in the
 * review report before anything commits):
 *   sammalöneregeln (monthly): monthly/dailyDivisor + monthly x tillägg
 *   procentregeln (monthly)  : monthly x 12 x rate / entitled days
 *   procentregeln (hourly)   : hourly x hours_per_week x 52 x rate / entitled
 * Avgifter on the liability use per-employee age tiers at the settlement
 * year (born <= 1937 exempt, fyllt 67 vid årets ingång 10.21%, otherwise
 * 31.42%), matching the rates the per-run accruals booked on 2940; a flat
 * 31.42% target would "correct" a correct booked balance to a wrong one
 * for companies with 67+ staff. The temporary youth discount is
 * deliberately NOT provisioned: it is payment-month- and cap-dependent and
 * expires Sep 2027, so the full rate is the prudent target (ÅRL
 * försiktighetsprincipen); youth accruals therefore show a top-up drift.
 *
 * The frozen report is stored on vacation_year_closures (BFL 7 kap: it is
 * the underlag for the adjustment entry). The UNIQUE
 * (company_id, vacation_year_start) makes replays a clean conflict.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre, sumOre } from '@/lib/money'
import { dailyDivisor } from './work-schedule'
import { getVacationYearBounds, type VacationYearBasis } from './vacation-year'
import { getVacationYearBasis, syncVacationLedgerForEmployees, type VacationBalanceRow } from './vacation-ledger'
import { calculateAgeAtYearStart, decryptPersonnummer } from './personnummer'
import { generateTrialBalance } from '@/lib/reports/trial-balance'

const STANDARD_AVGIFTER_RATE = 0.3142
/** Ålderspensionsavgift only, for fyllt 67 vid årets ingång (SAL 2 kap). */
const REDUCED_AVGIFTER_RATE = 0.1021
/** Threshold applies to payment years >= 2026; every close this module can
 * run settles 2026 or later, so the pre-2026 66-year threshold never applies. */
const REDUCED_AVGIFT_AGE = 67
/** Book an adjustment only beyond this drift (öre noise is not a bokslut post). */
const DRIFT_TOLERANCE_SEK = 1

export type VacationCloseResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown> }

export interface VacationCloseEmployeeRow {
  employee_id: string
  employee_name: string
  vacation_rule: string
  entitled_days: number
  taken_days: number
  remaining_days: number
  /** Days above the 20-day must-take floor: rolled into saved_days. */
  saveable_days: number
  /** Untaken days at/below the floor: flagged for manual handling. */
  untaken_below_floor_days: number
  /** Saved days whose origin year fell out of the 5-year window: forced payout. */
  expiring_days: number
  saved_days_before: Record<string, number>
  saved_days_after: Record<string, number>
  next_year_entitled: number
  day_value_sek: number
  computed_liability_sek: number
  /** Age-tier avgifter rate applied to this employee's liability for the
   * 2940 target (0 exempt, 0.1021 fyllt 67, 0.3142 standard). */
  avgifter_rate: number
}

export interface VacationCloseReport {
  vacation_year_start: string
  vacation_year_end: string
  next_year_start: string
  basis: VacationYearBasis
  rows: VacationCloseEmployeeRow[]
  sek: {
    computed_liability: number
    computed_avgifter: number
    booked_2920: number
    booked_2940: number
    drift_2920: number
    drift_2940: number
    adjustment_needed: boolean
  }
  adjustment_date: string
}

interface EmployeeRosterRow {
  id: string
  first_name: string
  last_name: string
  personnummer: string | null
  vacation_rule: string
  vacation_days_per_year: number
  salary_type: string
  monthly_salary: number | null
  hourly_rate: number | null
  hours_per_week: number | null
  workdays_per_week: number | null
  employment_start: string
  employment_end: string | null
}

function lastDayBefore(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** The employee master fields the day valuation reads. */
export type DayValueEmployee = Pick<
  EmployeeRosterRow,
  'vacation_rule' | 'vacation_days_per_year' | 'salary_type' | 'monthly_salary' | 'hourly_rate' | 'hours_per_week' | 'workdays_per_week'
>

/**
 * Simplified BFNAR 2016:10 value of one vacation day in SEK. Shared by the
 * year-close and the MCP vacation-balance tool; the v1 vacation-balance
 * route carries the same formula inline. All three must agree on the
 * semesterlöneskuld estimate.
 */
export function dayValueSek(emp: DayValueEmployee): number {
  const rate = emp.vacation_days_per_year >= 30 ? 0.144 : 0.12
  if (emp.salary_type === 'hourly') {
    const annualBasis = (emp.hourly_rate || 0) * (emp.hours_per_week ?? 40) * 52
    return roundOre((annualBasis * rate) / Math.max(emp.vacation_days_per_year, 1))
  }
  const monthly = emp.monthly_salary || 0
  if (emp.vacation_rule === 'sammaloneregeln') {
    // Dagslön + semestertillägg per day. The employee's tillägg rate lives on
    // the master row but the statutory floor 0.43% is used when absent.
    return roundOre(monthly / dailyDivisor(emp.workdays_per_week) + monthly * 0.0043)
  }
  return roundOre((monthly * 12 * rate) / Math.max(emp.vacation_days_per_year, 1))
}

/**
 * Age-tier avgifter rate for the semesterlöneskuld provision.
 *
 * The liability settles when vacation is taken during the NEXT vacation
 * year, so the tier is evaluated against that settlement year. This matches
 * the per-run accruals, which credit 2940 at each employee's actual rate
 * (calculation-engine.ts step 10). The temporary youth discount is not
 * applied here (see the module header). An absent or undecryptable
 * personnummer falls back to the standard rate, mirroring the run engine.
 */
function avgifterRateFor(emp: EmployeeRosterRow, settlementYear: number): number {
  if (!emp.personnummer) return STANDARD_AVGIFTER_RATE
  let pnr: string
  try {
    pnr = decryptPersonnummer(emp.personnummer)
  } catch {
    return STANDARD_AVGIFTER_RATE
  }
  const birthYear = parseInt(pnr.slice(0, 4))
  if (!Number.isFinite(birthYear)) return STANDARD_AVGIFTER_RATE
  if (birthYear <= 1937) return 0
  if (calculateAgeAtYearStart(pnr, settlementYear) >= REDUCED_AVGIFT_AGE) {
    return REDUCED_AVGIFTER_RATE
  }
  return STANDARD_AVGIFTER_RATE
}

/** Prorated entitlement for the new year (Semesterlagen 3a §: round UP). */
function nextYearEntitled(emp: EmployeeRosterRow, newYearStart: string, newYearEnd: string): number {
  if (emp.employment_end && emp.employment_end < newYearStart) return 0
  if (emp.employment_start >= newYearEnd) return 0
  const yearStartMs = Date.parse(`${newYearStart}T00:00:00Z`)
  const yearEndMs = Date.parse(`${newYearEnd}T00:00:00Z`)
  const fromMs = Math.max(yearStartMs, Date.parse(`${emp.employment_start}T00:00:00Z`))
  const toMs = emp.employment_end
    ? Math.min(yearEndMs, Date.parse(`${emp.employment_end}T00:00:00Z`) + 86_400_000)
    : yearEndMs
  const fraction = Math.max(0, toMs - fromMs) / (yearEndMs - yearStartMs)
  return Math.min(emp.vacation_days_per_year, Math.ceil(fraction * emp.vacation_days_per_year))
}

async function loadRoster(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VacationCloseResult<EmployeeRosterRow[]>> {
  const { data, error } = await supabase
    .from('employees')
    .select(
      'id, first_name, last_name, personnummer, vacation_rule, vacation_days_per_year, salary_type, monthly_salary, hourly_rate, hours_per_week, workdays_per_week, employment_start, employment_end',
    )
    .eq('company_id', companyId)
    .eq('is_active', true)
    .not('vacation_rule', 'in', '(none,semesterersattning)')
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  return { ok: true, data: (data ?? []) as unknown as EmployeeRosterRow[] }
}

async function bookedBalance(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<VacationCloseResult<{ booked2920: number; booked2940: number }>> {
  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .lte('period_start', asOfDate)
    .gte('period_end', asOfDate)
    .maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  if (!period) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: `Ingen räkenskapsperiod täcker ${asOfDate}.` },
    }
  }

  const tb = await generateTrialBalance(supabase, companyId, (period as { id: string }).id, {
    // Reads 29xx semesterlöneskuld accounts (class 2).
    closingEntry: 'include',
    toDate: asOfDate,
  })
  const balanceOf = (account: string): number => {
    const row = tb.rows.find((r) => r.account_number === account)
    if (!row) return 0
    // 2920/2940 are credit-normal liabilities.
    return roundOre(row.closing_credit - row.closing_debit)
  }
  return { ok: true, data: { booked2920: balanceOf('2920'), booked2940: balanceOf('2940') } }
}

export async function previewVacationYearClose(
  supabase: SupabaseClient,
  companyId: string,
  closingYearStart: string,
): Promise<VacationCloseResult<VacationCloseReport>> {
  const basis = await getVacationYearBasis(supabase, companyId)
  const bounds = getVacationYearBounds(closingYearStart)
  const yearEnd = lastDayBefore(bounds.end)
  const newYearStart = bounds.end
  const newYearBounds = getVacationYearBounds(newYearStart)

  // A year can only be closed once it has ended.
  const today = new Date().toISOString().slice(0, 10)
  if (today < bounds.end) {
    return {
      ok: false,
      code: 'VACATION_YEAR_NOT_ENDED',
      details: { vacation_year_start: closingYearStart, vacation_year_end: yearEnd },
    }
  }

  // Replay guard for previews too: a closed year has a frozen report already.
  const { data: existingClosure } = await supabase
    .from('vacation_year_closures')
    .select('id')
    .eq('company_id', companyId)
    .eq('vacation_year_start', closingYearStart)
    .maybeSingle()
  if (existingClosure) {
    return {
      ok: false,
      code: 'VACATION_YEAR_ALREADY_CLOSED',
      details: { vacation_year_start: closingYearStart },
    }
  }

  const roster = await loadRoster(supabase, companyId)
  if (!roster.ok) return roster

  // Make sure the closing year's ledger rows exist and are recomputed as of
  // the year end (seeds from cutover/legacy data on first touch).
  const sync = await syncVacationLedgerForEmployees(
    supabase,
    companyId,
    roster.data.map((e) => e.id),
    yearEnd,
  )
  if (!sync.ok) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: sync.message } }
  }

  const { data: ledgerRows, error: ledgerErr } = await supabase
    .from('employee_vacation_balances')
    .select('id, employee_id, vacation_year_start, entitled_days, accrued_days, taken_days, saved_days, forced_payout_days, status')
    .eq('company_id', companyId)
    .eq('vacation_year_start', closingYearStart)
  if (ledgerErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: ledgerErr.message } }
  }
  const ledgerByEmployee = new Map(
    ((ledgerRows ?? []) as unknown as VacationBalanceRow[]).map((r) => [r.employee_id, r]),
  )

  const closingYear = Number(closingYearStart.slice(0, 4))
  // The rolled liability is paid out during the new vacation year: that is
  // the year the avgifter age tier is evaluated against.
  const settlementYear = Number(newYearStart.slice(0, 4))
  const rows: VacationCloseEmployeeRow[] = []

  for (const emp of roster.data) {
    const ledger = ledgerByEmployee.get(emp.id)
    const entitled = ledger?.entitled_days ?? emp.vacation_days_per_year
    const taken = ledger?.taken_days ?? 0
    const savedBefore = (ledger?.saved_days ?? {}) as Record<string, number>
    const remaining = Math.max(0, roundOre(entitled - taken))

    // Semesterlagen 18 §: only days exceeding the 20-day floor are saveable.
    const saveable = Math.max(0, Math.min(remaining, entitled - 20))
    const untakenBelowFloor = roundOre(remaining - saveable)

    // 5-year expiry: a day saved in origin year X is takeable through X + 5.
    // Rolling into the new year, origins <= closingYear - 5 fall out.
    let expiring = 0
    const savedAfter: Record<string, number> = {}
    for (const [originYear, days] of Object.entries(savedBefore)) {
      const numDays = Number(days) || 0
      if (numDays <= 0) continue
      if (Number(originYear) <= closingYear - 5) {
        expiring = roundOre(expiring + numDays)
      } else {
        savedAfter[originYear] = numDays
      }
    }
    if (saveable > 0) {
      savedAfter[String(closingYear)] = roundOre((savedAfter[String(closingYear)] ?? 0) + saveable)
    }

    const dayValue = dayValueSek(emp)
    // The liability covers everything still owed: this year's untaken days
    // (incl. the below-floor flag) + all saved days + expiring days awaiting
    // payout.
    const liabilityDays = roundOre(
      remaining + Object.values(savedBefore).reduce((s, d) => s + (Number(d) || 0), 0),
    )
    const liability = roundOre(liabilityDays * dayValue)

    rows.push({
      employee_id: emp.id,
      employee_name: `${emp.first_name} ${emp.last_name}`,
      vacation_rule: emp.vacation_rule,
      entitled_days: entitled,
      taken_days: taken,
      remaining_days: remaining,
      saveable_days: saveable,
      untaken_below_floor_days: untakenBelowFloor,
      expiring_days: expiring,
      saved_days_before: savedBefore,
      saved_days_after: savedAfter,
      next_year_entitled: nextYearEntitled(emp, newYearStart, newYearBounds.end),
      day_value_sek: dayValue,
      computed_liability_sek: liability,
      avgifter_rate: avgifterRateFor(emp, settlementYear),
    })
  }

  const computedLiability = sumOre(rows.map((r) => r.computed_liability_sek))
  const computedAvgifter = sumOre(
    rows.map((r) => roundOre(r.computed_liability_sek * r.avgifter_rate)),
  )

  const booked = await bookedBalance(supabase, companyId, yearEnd)
  if (!booked.ok) return booked

  const drift2920 = roundOre(computedLiability - booked.data.booked2920)
  const drift2940 = roundOre(computedAvgifter - booked.data.booked2940)

  return {
    ok: true,
    data: {
      vacation_year_start: closingYearStart,
      vacation_year_end: yearEnd,
      next_year_start: newYearStart,
      basis,
      rows,
      sek: {
        computed_liability: computedLiability,
        computed_avgifter: computedAvgifter,
        booked_2920: booked.data.booked2920,
        booked_2940: booked.data.booked2940,
        drift_2920: drift2920,
        drift_2940: drift2940,
        adjustment_needed:
          Math.abs(drift2920) > DRIFT_TOLERANCE_SEK || Math.abs(drift2940) > DRIFT_TOLERANCE_SEK,
      },
      adjustment_date: yearEnd,
    },
  }
}

export async function commitVacationYearClose(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  closingYearStart: string,
  options: { bookAdjustment: boolean },
): Promise<VacationCloseResult<{ closure_id: string; adjustment_entry_id: string | null; report: VacationCloseReport }>> {
  const preview = await previewVacationYearClose(supabase, companyId, closingYearStart)
  if (!preview.ok) return preview
  const report = preview.data

  // Period-lock pre-check BEFORE any writes so a locked bokslut period fails
  // the whole close cleanly (the DB trigger is the backstop).
  if (options.bookAdjustment && report.sek.adjustment_needed) {
    const { checkPeriodLock } = await import('@/lib/api/v1/check-period-lock')
    const lockVerdict = await checkPeriodLock(supabase, companyId, report.adjustment_date)
    if (lockVerdict.locked) {
      return {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
          adjustment_date: report.adjustment_date,
        },
      }
    }
  }

  // 1. Closure row: the UNIQUE constraint is the replay anchor.
  const { data: closure, error: closureErr } = await supabase
    .from('vacation_year_closures')
    .insert({
      company_id: companyId,
      vacation_year_start: closingYearStart,
      closed_by: userId,
      report: report as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()
  if (closureErr) {
    if (closureErr.code === '23505') {
      return {
        ok: false,
        code: 'VACATION_YEAR_ALREADY_CLOSED',
        details: { vacation_year_start: closingYearStart },
      }
    }
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: closureErr.message } }
  }
  const closureId = (closure as { id: string }).id

  // 2. Close the year's ledger rows.
  const { error: closeErr } = await supabase
    .from('employee_vacation_balances')
    .update({ status: 'closed' })
    .eq('company_id', companyId)
    .eq('vacation_year_start', closingYearStart)
  if (closeErr) {
    return { ok: false, code: 'INTERNAL_ERROR', details: { message: closeErr.message } }
  }

  // 3. Next-year rows: entitlement + rolled saved days + forced payouts.
  //    Upsert MERGES over any lazy-seeded row; taken_days is recomputed by
  //    the sync below, so seeding it 0 here is safe.
  const nextRows = report.rows.map((row) => ({
    company_id: companyId,
    employee_id: row.employee_id,
    vacation_year_start: report.next_year_start,
    entitled_days: row.next_year_entitled,
    accrued_days: 0,
    taken_days: 0,
    saved_days: row.saved_days_after,
    forced_payout_days: row.expiring_days,
    status: 'open',
  }))
  if (nextRows.length > 0) {
    const { error: nextErr } = await supabase
      .from('employee_vacation_balances')
      .upsert(nextRows, { onConflict: 'company_id,employee_id,vacation_year_start' })
    if (nextErr) {
      return { ok: false, code: 'INTERNAL_ERROR', details: { message: nextErr.message } }
    }
  }

  // Recompute taken_days on the fresh rows from any already-booked runs in
  // the new year (non-fatal, same contract as the booking hook).
  await syncVacationLedgerForEmployees(
    supabase,
    companyId,
    report.rows.map((r) => r.employee_id),
  )

  // 4. Drift adjustment verifikation (7290/2920 + 7519/2940).
  let adjustmentEntryId: string | null = null
  if (options.bookAdjustment && report.sek.adjustment_needed) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lte('period_start', report.adjustment_date)
      .gte('period_end', report.adjustment_date)
      .maybeSingle()
    if (!period) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { message: `Ingen räkenskapsperiod täcker ${report.adjustment_date}.` },
      }
    }

    const lines: Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description?: string }> = []
    const d2920 = report.sek.drift_2920
    if (Math.abs(d2920) > DRIFT_TOLERANCE_SEK) {
      if (d2920 > 0) {
        lines.push({ account_number: '7290', debit_amount: d2920, credit_amount: 0, line_description: 'Justering semesterlöneskuld' })
        lines.push({ account_number: '2920', debit_amount: 0, credit_amount: d2920, line_description: 'Justering semesterlöneskuld' })
      } else {
        lines.push({ account_number: '2920', debit_amount: -d2920, credit_amount: 0, line_description: 'Justering semesterlöneskuld' })
        lines.push({ account_number: '7290', debit_amount: 0, credit_amount: -d2920, line_description: 'Justering semesterlöneskuld' })
      }
    }
    const d2940 = report.sek.drift_2940
    if (Math.abs(d2940) > DRIFT_TOLERANCE_SEK) {
      if (d2940 > 0) {
        lines.push({ account_number: '7519', debit_amount: d2940, credit_amount: 0, line_description: 'Justering upplupna avgifter semester' })
        lines.push({ account_number: '2940', debit_amount: 0, credit_amount: d2940, line_description: 'Justering upplupna avgifter semester' })
      } else {
        lines.push({ account_number: '2940', debit_amount: -d2940, credit_amount: 0, line_description: 'Justering upplupna avgifter semester' })
        lines.push({ account_number: '7519', debit_amount: 0, credit_amount: -d2940, line_description: 'Justering upplupna avgifter semester' })
      }
    }

    if (lines.length > 0) {
      try {
        const { createJournalEntry } = await import('@/lib/bookkeeping/engine')
        const entry = await createJournalEntry(supabase, companyId, userId, {
          fiscal_period_id: (period as { id: string }).id,
          entry_date: report.adjustment_date,
          description: `Semesterårsavslut ${closingYearStart.slice(0, 4)}: justering semesterlöneskuld`,
          source_type: 'salary_payment',
          source_id: closureId,
          lines,
        })
        adjustmentEntryId = entry.id
        const { error: linkError } = await supabase
          .from('vacation_year_closures')
          .update({ adjustment_entry_id: entry.id })
          .eq('id', closureId)
        if (linkError) {
          // The verifikat IS posted; only the closure link failed. Surface
          // it with the entry id so nobody re-posts the adjustment manually.
          return {
            ok: false,
            code: 'VACATION_CLOSE_ADJUSTMENT_FAILED',
            details: {
              closure_id: closureId,
              adjustment_entry_id: entry.id,
              message: `Justeringsverifikatet är bokfört men kunde inte länkas till semesterårsavslutet: ${linkError.message}`,
            },
          }
        }
      } catch (err) {
        // The days roll committed; the adjustment did not. Surface loudly:
        // the closure row (sans adjustment_entry_id) shows exactly what is
        // missing, and the entry can be posted manually from the report.
        return {
          ok: false,
          code: 'VACATION_CLOSE_ADJUSTMENT_FAILED',
          details: {
            closure_id: closureId,
            message: err instanceof Error ? err.message : 'unknown',
          },
        }
      }
    }
  }

  return { ok: true, data: { closure_id: closureId, adjustment_entry_id: adjustmentEntryId, report } }
}
