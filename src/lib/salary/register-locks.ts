/**
 * Register locks: which salary run reads a register day, and whether a write
 * may touch it.
 *
 * A row in salary_absence_days or salary_worked_days is read by one run: the
 * run it is carried to (carried_to_run_id, a late day, lib/salary/late-days.ts)
 * or else the run whose avvikelseperiod (deviation window,
 * salary_runs.deviation_period_start..deviation_period_end, NULL = the pay
 * month) holds its date. A run in review, approved, paid or booked has
 * consumed what it reads. Writing to it afterwards would make the register
 * disagree with what was calculated, paid or booked, silently: the payslip
 * says one thing, the register another, and AGI frånvarouppgifter are derived
 * from the register. So the registers refuse with
 * SALARY_REGISTER_DATES_LOCKED_BY_RUN, before any write and in dry runs too
 * (a preview that hides the lock is not a preview of what the write would
 * do). lib/salary/absence.ts and lib/salary/worked-days.ts ask this module.
 *
 * Draft runs never lock: they recalculate on demand. A corrected original
 * never locks the days already registered: its correction run reads them in
 * its place. Its pay went out, though, so a new day in its window is a late
 * day like one under any paid run (late-days.ts), for an employee it paid;
 * for one added to the correction the day is the correction's own.
 *
 * The ways out, by what read the day:
 *   - a run in review or approved, neither paid nor declared: revert it to
 *     draft and register the day there;
 *   - a run that is paid, booked or has its AGI filed, for a day not
 *     registered yet: a late day. It is registered on its real date with
 *     carried_to_run_id naming the next ordinary run that is neither paid
 *     nor declared, which must be a draft with the employee on it, paid the
 *     same way (monthly or hourly) as in the period the day belongs to. That
 *     run deducts or pays the day and reports it in its own AGI (the law is
 *     in late-days.ts). A correction draft takes late days only when named
 *     and while its period's AGI is not at Skatteverket;
 *   - no run, for an absence day between two windows behind a paid or
 *     declared run, in a pay month a settled run paid the employee a monthly
 *     salary: a late day of that run, the same way (gapPeriodRun);
 *   - a day already registered that a paid or declared run read: it is part
 *     of what was paid and is not rewritten. A difference is settled on the
 *     next payslip.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isSalaryExtraRunsEnabled } from '@/lib/env/salary-extra-runs-switch'
import { SalaryCalculationPolicySchema } from './calculation-policy'
import { runDeviationWindow, type DateWindow } from './deviation-period'
import {
  CALENDAR_PRICED_ABSENCE_TYPES,
  FRANVARO_ABSENCE_TYPES,
  correctionPeriodFiled,
  describeLateDates,
  paidRunHasHandDeduction,
  runIsSettled,
} from './late-days'

/** Run statuses whose days are locked. */
export const REGISTER_LOCKING_RUN_STATUSES = ['review', 'approved', 'paid', 'booked'] as const

export type RegisterLockingRunStatus = (typeof REGISTER_LOCKING_RUN_STATUSES)[number]

export const SALARY_REGISTER_DATES_LOCKED_BY_RUN = 'SALARY_REGISTER_DATES_LOCKED_BY_RUN'
export const SALARY_REGISTER_LATE_DAY_REFUSED = 'SALARY_REGISTER_LATE_DAY_REFUSED'

/** Why a run holds the dates. */
export type RegisterLockReason =
  /** Calculated or approved, neither paid nor declared: revert it to draft. */
  | 'run_not_settled'
  /** Already registered, and a paid or declared run read it. */
  | 'read_by_settled_run'
  /** Not registered yet, on a date a paid or declared run read: carry it to the next run. */
  | 'late_day_needs_later_run'

/** A run as the late-day messages name it. */
export interface RegisterRunRef {
  salary_run_id: string
  status: string
  period_year: number
  period_month: number
}

/**
 * The run that locks a write and the dates it locks. The field names are the
 * `details` of SALARY_REGISTER_DATES_LOCKED_BY_RUN as consumers surface them.
 */
export type RegisterRunLock = {
  salary_run_id: string
  /** 'corrected': a declared run whose correction is open (a new day only). */
  status: RegisterLockingRunStatus | 'corrected'
  period_year: number
  period_month: number
  /** The run's window, ISO dates inclusive (the pay month for a legacy NULL window). */
  deviation_period_start: string
  deviation_period_end: string
  /** The target dates the run holds, ISO, sorted, unique. */
  locked_dates: string[]
  /** Paid, booked or declared. */
  settled: boolean
  reason: RegisterLockReason
  /**
   * reason late_day_needs_later_run: the run the days go to, the first later
   * run that is neither paid nor declared. Null when the company has none yet.
   */
  later_salary_run?: RegisterRunRef | null
}

/** Why late days cannot be carried to the named run. */
export type LateDayRefusalReason =
  /** No run of the company has that id. */
  | 'not_found'
  /** The run is past draft, neither paid nor declared: revert it. */
  | 'not_draft'
  /** The run's window does not come after the days. */
  | 'not_later'
  /**
   * Another later ordinary run, neither paid nor declared, takes the days
   * (later_salary_run): one comes first, or the named run is paid, declared
   * or corrected.
   */
  | 'not_next'
  /**
   * The named run is a correction whose period's AGI is already at
   * Skatteverket: its AGI is a rättelse, which takes no added
   * frånvarouppgift. later_salary_run takes the days.
   */
  | 'correction_period_filed'
  /**
   * The named run is a correction, and the paid run it replaces carried no
   * deduction typed by hand for the employee: there is nothing for the days
   * to replace, so they go to later_salary_run.
   */
  | 'correction_without_hand_deduction'
  /** The employee is not on the run. */
  | 'employee_not_on_run'
  /**
   * The company prices long leave per calendar day (long_leave =
   * calendar_after_five_workdays), which a late parental, unpaid or sick day
   * cannot join (lateAbsenceRefusal in derive-absence-line-items.ts).
   */
  | 'calendar_long_leave'
  /**
   * A late VAB or parental day of an hourly employee: no later pay is reduced
   * by it, so its frånvarouppgift has no later period (late-days.ts).
   */
  | 'hourly_pay'
  /**
   * The employee was paid monthly in the period the days belong to and
   * hourly on the named run, or the other way round (period_salary_run): the
   * run would price the days on pay that period never had.
   */
  | 'pay_type_changed'
  /**
   * The employee had no payslip on the run that read the absence days
   * (period_salary_run): nothing was paid that a deduction could settle.
   */
  | 'not_paid_then'

/**
 * The failure a register module returns when a write may not proceed: a
 * failed lookup, the lock itself, or late days the named run cannot take.
 * Shaped to slot straight into AbsenceResult / WorkedDaysResult.
 */
export type RegisterLockFailure =
  | { ok: false; code: 'INTERNAL_ERROR'; details: { message: string } }
  | { ok: false; code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN'; details: RegisterRunLock }
  | { ok: false; code: 'SALARY_REGISTER_LATE_DAY_REFUSED'; details: LateDayRefusal }

/** The details of SALARY_REGISTER_LATE_DAY_REFUSED. */
export type LateDayRefusal = {
  carried_to_run_id: string
  reason: LateDayRefusalReason
  late_dates: string[]
  /** The named run, when the company has it. */
  salary_run?: RegisterRunRef
  /** reason not_next, correction_period_filed: the run the days go to instead. */
  later_salary_run?: RegisterRunRef | null
  /** reason pay_type_changed, not_paid_then: the run that read the days. */
  period_salary_run?: RegisterRunRef
}

const STATUS_SV: Record<string, string> = {
  draft: 'utkast',
  review: 'beräknad',
  approved: 'godkänd',
  paid: 'utbetald',
  booked: 'bokförd',
  corrected: 'rättad',
}

/** "2026-10 (bokförd)"; an API caller also gets the run's id to act on. */
function runLabelSv(run: Record<string, unknown> | RegisterRunRef, door: 'dashboard' | 'api'): string {
  const period = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const status = typeof run.status === 'string' ? STATUS_SV[run.status] ?? run.status : null
  const parts = [status, door === 'api' && typeof run.salary_run_id === 'string' ? run.salary_run_id : null].filter(Boolean)
  return parts.length > 0 ? `${period} (${parts.join(', ')})` : period
}

function datesSv(dates: unknown): string {
  const list = Array.isArray(dates) ? (dates as string[]) : []
  return describeLateDates(list)
}

/**
 * The Swedish sentence for a register refusal, naming the run and the dates
 * and saying the way out. `door` decides how the late-day way is put: the
 * dashboard registers a day from the next run's payslip, an API caller names
 * the run in carried_to_run_id. Null for any other code, or details without
 * the fields.
 */
export function registerRefusalMessageSv(
  code: string,
  details: Record<string, unknown> | undefined,
  door: 'dashboard' | 'api',
): string | null {
  if (!details) return null
  if (code === SALARY_REGISTER_DATES_LOCKED_BY_RUN && typeof details.salary_run_id === 'string') {
    const run = runLabelSv(details, door)
    const dates = datesSv(details.locked_dates)
    if (details.reason === 'late_day_needs_later_run') {
      const later = details.later_salary_run as RegisterRunRef | null | undefined
      const where = later
        ? `nästa lönekörning, ${runLabelSv(later, door)}`
        : 'nästa lönekörning, som inte är skapad än'
      const how =
        door === 'dashboard'
          ? 'Registrera dem i kalendern på lönebeskedet i den körningen.'
          : 'Ange den körningens id i carried_to_run_id.'
      return (
        `Dagarna ${dates} hör till lönekörning ${run}, som redan är utbetald eller deklarerad. ` +
        `En sent känd dag registreras på sitt riktiga datum och dras i ${where}, som också redovisar frånvaron i sin arbetsgivardeklaration. ${how}`
      )
    }
    if (details.reason === 'read_by_settled_run') {
      return (
        `Dagarna ${dates} är redan registrerade och ingår i lönekörning ${run}, som är utbetald eller deklarerad. ` +
        'De ändras inte i efterhand: reglera en skillnad med en egen rad på nästa lönebesked.'
      )
    }
    return `Dagarna ${dates} ingår i lönekörning ${run}, som redan har räknat dem. Återställ den till utkast och registrera dagarna där.`
  }
  if (code === SALARY_REGISTER_LATE_DAY_REFUSED && typeof details.reason === 'string') {
    const dates = datesSv(details.late_dates)
    const run = details.salary_run ? `lönekörning ${runLabelSv(details.salary_run as RegisterRunRef, door)}` : 'lönekörningen'
    switch (details.reason as LateDayRefusalReason) {
      case 'not_found':
        return 'Lönekörningen som de sena dagarna skulle knytas till finns inte i företaget.'
      case 'not_draft':
        return `Sena dagar knyts till nästa lönekörning medan den är ett utkast, och ${run} är inte det. Återställ den till utkast först.`
      case 'not_later':
        return `${run.charAt(0).toUpperCase()}${run.slice(1)} kommer inte efter dagarna ${dates}. En sen dag dras i en senare körning.`
      case 'not_next': {
        const later = details.later_salary_run as RegisterRunRef | null | undefined
        return later
          ? `Dagarna ${dates} dras i lönekörning ${runLabelSv(later, door)}, den första senare körningen med den anställde som varken är utbetald eller deklarerad. ` +
              'Knyt dem till den, eller lägg först till den anställde på en tidigare körning som ska dra dem.'
          : `Dagarna ${dates} dras i nästa lönekörning med den anställde som varken är utbetald eller deklarerad.`
      }
      case 'employee_not_on_run':
        return `Den anställde finns inte på ${run}. Lägg till den anställde på körningen först.`
      case 'calendar_long_leave':
        return (
          `Företaget drar lång frånvaro per kalenderdag. Föräldraledighet, tjänstledighet och sjukdagar från en tidigare period (${dates}) ` +
          'kan då inte räknas i en senare körning: lägg in avdraget som en egen rad på lönebeskedet.'
        )
      case 'hourly_pay':
        return (
          `Den anställde har timlön, så VAB och föräldraledighet ${dates} drar inget från lönen i en senare körning. ` +
          'Frånvaron påverkade lönen i perioden då den var, och frånvarouppgiften hör inte till en senare arbetsgivardeklaration.'
        )
      case 'correction_period_filed': {
        const later = details.later_salary_run as RegisterRunRef | null | undefined
        return (
          `${run.charAt(0).toUpperCase()}${run.slice(1)} rättar en period vars arbetsgivardeklaration redan finns hos Skatteverket, ` +
          'och en rättelse kan inte ta emot nya frånvarouppgifter. ' +
          (later
            ? `Dagarna ${dates} dras i lönekörning ${runLabelSv(later, door)}.`
            : `Dagarna ${dates} dras i nästa ordinarie lönekörning, som inte är skapad än.`)
        )
      }
      case 'correction_without_hand_deduction': {
        const later = details.later_salary_run as RegisterRunRef | null | undefined
        return (
          `${run.charAt(0).toUpperCase()}${run.slice(1)} är en rättelse. En rättelse tar bara emot sen frånvaro, och bara för att ersätta ` +
          'ett avdrag för den som skrevs in för hand på den anställdes lönebesked i den utbetalda körningen. ' +
          (later
            ? `Dagarna ${dates} dras i lönekörning ${runLabelSv(later, door)}.`
            : `Dagarna ${dates} dras i nästa ordinarie lönekörning, som inte är skapad än.`)
        )
      }
      case 'pay_type_changed': {
        const period = details.period_salary_run ? `lönekörning ${runLabelSv(details.period_salary_run as RegisterRunRef, door)}` : 'perioden de hör till'
        return (
          `Den anställde hade en annan lönetyp (månadslön eller timlön) i ${period} än på ${run}. ` +
          `Dagarna ${dates} kan då inte räknas om i en senare körning: lägg in skillnaden som en egen rad på lönebeskedet.`
        )
      }
      case 'not_paid_then': {
        const period = details.period_salary_run ? `lönekörning ${runLabelSv(details.period_salary_run as RegisterRunRef, door)}` : 'lönekörningen som dagarna hör till'
        return `Den anställde fick ingen lön i ${period}, så det finns inget utbetalt för dagarna ${dates} att dra av i efterhand.`
      }
    }
  }
  return null
}

/** Which register a write targets. */
export type RegisterKind = 'absence' | 'worked'

/** What an upsert stores: the carried_to_run_id of each target date. */
export interface RegisterUpsertPlan {
  /** Per target date: the run it is carried to, or null (read by its window). */
  carriedTo: Map<string, string | null>
  /**
   * Draft runs that read some of the target days through a carry: their
   * calculation for the employee is cleared with the write.
   */
  carriedReaderRunIds: string[]
}

export type RegisterUpsertPlanResult = { ok: true; plan: RegisterUpsertPlan } | RegisterLockFailure

export type RegisterDeleteCheckResult = { ok: true; carriedReaderRunIds: string[] } | RegisterLockFailure

interface CompanyRun {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string | null
  deviation_period_start: string | null
  deviation_period_end: string | null
  agi_submitted_at: string | null
  corrects_run_id: string | null
}

interface RegisterRow {
  date: string
  carried_to_run_id: string | null
}

const LOCKING: readonly string[] = REGISTER_LOCKING_RUN_STATUSES

function internal(message: string): RegisterLockFailure {
  return { ok: false, code: 'INTERNAL_ERROR', details: { message } }
}

function byPeriod(a: CompanyRun, b: CompanyRun): number {
  return a.period_year - b.period_year || a.period_month - b.period_month
}

function windowOf(run: CompanyRun): DateWindow {
  return runDeviationWindow(run)
}

function refOf(run: CompanyRun): RegisterRunRef {
  return {
    salary_run_id: run.id,
    status: run.status,
    period_year: run.period_year,
    period_month: run.period_month,
  }
}

/**
 * The runs with the employee on them, for a company with several runs in one
 * month (SALARY_EXTRA_RUNS_COMPANY_IDS): undefined for every other company,
 * whose windows each have one live run.
 */
async function loadEmployeeRuns(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<{ runs: ReadonlySet<string> | undefined } | { error: string }> {
  if (!isSalaryExtraRunsEnabled(companyId)) return { runs: undefined }
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('salary_run_id')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
  if (error) return { error: error.message }
  return { runs: new Set(((data ?? []) as Array<{ salary_run_id: string }>).map((row) => row.salary_run_id)) }
}

/** Every run of the company, one query, literal select. */
async function loadCompanyRuns(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ runs: CompanyRun[] } | { error: string }> {
  const { data, error } = await supabase
    .from('salary_runs')
    .select(
      'id, status, period_year, period_month, payment_date, deviation_period_start, deviation_period_end, agi_submitted_at, corrects_run_id',
    )
    .eq('company_id', companyId)
  if (error) return { error: error.message }
  return { runs: ((Array.isArray(data) ? data : []) as CompanyRun[]).slice().sort(byPeriod) }
}

/**
 * The earliest run in a locking status whose window holds the date: the run
 * that read it. `employeeRuns` (several runs in one month, extra-runs.ts):
 * the runs with the employee on them. Runs of one period share a window but
 * never a person, so the live run that has the employee is the one that
 * reads the day; without one, the earliest locking run decides, as before.
 */
function windowLockingRun(runs: CompanyRun[], date: string, employeeRuns?: ReadonlySet<string>): CompanyRun | null {
  if (employeeRuns) {
    const own = runs.find((run) => {
      if (run.status === 'corrected' || !employeeRuns.has(run.id)) return false
      const window = windowOf(run)
      return date >= window.start && date <= window.end
    })
    if (own) return LOCKING.includes(own.status) ? own : null
  }
  for (const run of runs) {
    if (!LOCKING.includes(run.status)) continue
    const window = windowOf(run)
    if (date >= window.start && date <= window.end) return run
  }
  return null
}

/**
 * The run that reads the rows carried to `runId` now: the run itself, or the
 * correction that replaced it. Null for a corrected run without a correction.
 */
function liveCarriedReader(runs: CompanyRun[], runId: string): CompanyRun | null {
  const seen = new Set<string>()
  let run = runs.find((r) => r.id === runId) ?? null
  while (run && run.status === 'corrected') {
    seen.add(run.id)
    const correctedId: string = run.id
    run = runs.find((r) => r.corrects_run_id === correctedId && !seen.has(r.id)) ?? null
  }
  return run
}

function byWindowStart(a: CompanyRun, b: CompanyRun): number {
  const startA = windowOf(a).start
  const startB = windowOf(b).start
  if (startA !== startB) return startA < startB ? -1 : 1
  return byPeriod(a, b)
}

/**
 * Where a late day on `date` goes: the first later ordinary run that is
 * neither paid nor declared, a draft with the employee on it (`onRoster`:
 * the runs with the employee's payslip). Failing that, the first such run
 * with the employee (to revert to draft), then the first draft (to add the
 * employee to), so a refusal still names a way. A correction run is never
 * the default: its original's pay went out in full (late-days.ts).
 */
function nextUnsettledRun(runs: CompanyRun[], date: string, onRoster: ReadonlySet<string>): CompanyRun | null {
  const later = runs
    .filter((run) => !run.corrects_run_id && !runIsSettled(run) && windowOf(run).start > date)
    .sort(byWindowStart)
  return (
    later.find((run) => run.status === 'draft' && onRoster.has(run.id)) ??
    later.find((run) => onRoster.has(run.id)) ??
    later.find((run) => run.status === 'draft') ??
    later[0] ??
    null
  )
}

/** The corrected runs whose window holds `date`: the paid versions of its period. */
function correctedWindowRuns(runs: CompanyRun[], date: string): CompanyRun[] {
  return runs.filter((run) => {
    if (run.status !== 'corrected') return false
    const window = windowOf(run)
    return date >= window.start && date <= window.end
  })
}

/** How many runs a run corrects, through its chain: the later version is the deeper one. */
function chainDepth(runs: CompanyRun[], run: CompanyRun): number {
  const seen = new Set<string>([run.id])
  let depth = 0
  let parentId = run.corrects_run_id
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    depth += 1
    parentId = runs.find((r) => r.id === parentId)?.corrects_run_id ?? null
  }
  return depth
}

/**
 * The run that decides a new day on `date`: the run in a locking status whose
 * window holds it, or, when that run is under correction, the last corrected
 * version that paid the employee (`paidByCorrected`: corrected runs with the
 * employee's payslip). That pay went out, so the day is a late day of a later
 * run, as it would be under that run itself. An employee no version paid
 * (added to the correction) has the day read by the correction, as before.
 */
function newDayWindowRun(
  runs: CompanyRun[],
  date: string,
  paidByCorrected: ReadonlySet<string>,
  employeeRuns?: ReadonlySet<string>,
): CompanyRun | null {
  const live = windowLockingRun(runs, date, employeeRuns)
  // An ordinary run that reads the window decides it; only a correction
  // defers to the version it replaces.
  if (live && (runIsSettled(live) || !live.corrects_run_id)) return live
  const paid = correctedWindowRuns(runs, date).filter((run) => paidByCorrected.has(run.id))
  if (paid.length === 0) return live
  return paid.reduce((latest, run) => (chainDepth(runs, run) > chainDepth(runs, latest) ? run : latest))
}

/**
 * The run whose pay an absence day between two windows belongs to, or null.
 * After a switch from previous_month to same_month, October's run read
 * September and November's read November. Once November is paid or declared
 * no run reads October any more (the next starts after November's window,
 * deviation-period.ts), while October's monthly salary went out in full: an
 * October absence was deducted and reported nowhere. Such a day belongs to
 * the settled run of its own pay month (its last version), and the caller
 * makes it a late day of the next run when that run paid the employee a
 * monthly salary (late-days.ts has the law). When only an earlier version
 * did, the late day is refused (not_paid_then).
 *
 * Null, and the day stays as before, when a window holds the day (a draft's
 * still reads it), when no settled run comes after it, when no settled run
 * paid its pay month (a month without a run paid nobody), and when that run's
 * own window does not end before the day (history from before a company's
 * first window). `versions`: every settled run of the pay month, the run
 * included, whose payslips say what the employee was paid.
 */
function gapPeriodRun(runs: CompanyRun[], date: string): { run: CompanyRun; versions: CompanyRun[] } | null {
  const settled = runs.filter((run) => runIsSettled(run))
  if (!settled.some((run) => !run.corrects_run_id && windowOf(run).start > date)) return null
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const paid = settled.filter((run) => run.period_year === year && run.period_month === month)
  if (paid.length === 0) return null
  const periodRun = paid.reduce((latest, run) => (chainDepth(runs, run) > chainDepth(runs, latest) ? run : latest))
  if (windowOf(periodRun).end >= date) return null
  const holds = (run: CompanyRun) => {
    const window = windowOf(run)
    return date >= window.start && date <= window.end
  }
  if (runs.some(holds)) return null
  return { run: periodRun, versions: paid }
}

/** The pay type a payslip was priced on: its own, else the employee's. */
function slipPayType(slip: RunPayslip | undefined): string | null {
  return slip ? (slip.salary_type ?? slip.employee?.salary_type ?? null) : null
}

interface Refusal {
  run: CompanyRun
  date: string
  reason: RegisterLockReason
}

/**
 * The lock to report for a set of refusals: the earliest run by period, with
 * every date it holds for the first reason found for it.
 */
function lockFailure(refusals: Refusal[], runs: CompanyRun[], onRoster: ReadonlySet<string>): RegisterLockFailure | null {
  if (refusals.length === 0) return null
  const first = refusals.slice().sort((a, b) => byPeriod(a.run, b.run) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0]
  const same = refusals.filter((r) => r.run.id === first.run.id && r.reason === first.reason)
  const lockedDates = Array.from(new Set(same.map((r) => r.date))).sort()
  const window = windowOf(first.run)
  const lock: RegisterRunLock = {
    salary_run_id: first.run.id,
    status: first.run.status as RegisterRunLock['status'],
    period_year: first.run.period_year,
    period_month: first.run.period_month,
    deviation_period_start: window.start,
    deviation_period_end: window.end,
    locked_dates: lockedDates,
    settled: runIsSettled(first.run),
    reason: first.reason,
  }
  if (first.reason === 'late_day_needs_later_run') {
    const next = nextUnsettledRun(runs, lockedDates[lockedDates.length - 1], onRoster)
    lock.later_salary_run = next ? refOf(next) : null
  }
  return { ok: false, code: SALARY_REGISTER_DATES_LOCKED_BY_RUN, details: lock }
}

/** The lock a registered row is under: its carry's live reader, or its window's run. */
function rowRefusal(runs: CompanyRun[], row: RegisterRow, employeeRuns?: ReadonlySet<string>): Refusal | null {
  const run = row.carried_to_run_id
    ? liveCarriedReader(runs, row.carried_to_run_id)
    : windowLockingRun(runs, row.date, employeeRuns)
  if (!run || !LOCKING.includes(run.status)) return null
  return { run, date: row.date, reason: runIsSettled(run) ? 'read_by_settled_run' : 'run_not_settled' }
}

function toRegisterRows(kind: RegisterKind, data: unknown): RegisterRow[] {
  const rows = (Array.isArray(data) ? data : []) as Array<{
    absence_date?: string
    work_date?: string
    carried_to_run_id?: string | null
  }>
  return rows.map((row) => ({
    date: (kind === 'absence' ? row.absence_date : row.work_date) as string,
    carried_to_run_id: row.carried_to_run_id ?? null,
  }))
}

/** The rows already registered on the target days (the natural key), with their carry. */
async function loadExistingRows(
  supabase: SupabaseClient,
  companyId: string,
  args: { kind: RegisterKind; employeeId: string; dates: string[]; absenceType?: string },
): Promise<{ rows: RegisterRow[] } | { error: string }> {
  if (args.kind === 'absence') {
    let query = supabase
      .from('salary_absence_days')
      .select('absence_date, carried_to_run_id')
      .eq('company_id', companyId)
      .eq('employee_id', args.employeeId)
      .in('absence_date', args.dates)
    if (args.absenceType) query = query.eq('absence_type', args.absenceType)
    const { data, error } = await query
    if (error) return { error: error.message }
    return { rows: toRegisterRows('absence', data) }
  }
  const { data, error } = await supabase
    .from('salary_worked_days')
    .select('work_date, carried_to_run_id')
    .eq('company_id', companyId)
    .eq('employee_id', args.employeeId)
    .in('work_date', args.dates)
  if (error) return { error: error.message }
  return { rows: toRegisterRows('worked', data) }
}

/** The rows a range delete reaches, with their carry. */
async function loadRangeRows(
  supabase: SupabaseClient,
  companyId: string,
  args: { kind: RegisterKind; employeeId: string; from: string; to: string; absenceType?: string },
): Promise<{ rows: RegisterRow[] } | { error: string }> {
  // Every row of the range, past PostgREST's 1 000-row page: a row left
  // unread would be deleted without its lock being judged.
  try {
    if (args.kind === 'absence') {
      const data = await fetchAllRows<{ absence_date: string; carried_to_run_id: string | null }>(({ from, to }) => {
        let query = supabase
          .from('salary_absence_days')
          .select('absence_date, carried_to_run_id')
          .eq('company_id', companyId)
          .eq('employee_id', args.employeeId)
          .gte('absence_date', args.from)
          .lte('absence_date', args.to)
        if (args.absenceType) query = query.eq('absence_type', args.absenceType)
        // (employee_id, absence_date, absence_type) is unique: a total order for paging.
        return query.order('absence_date').order('absence_type').range(from, to)
      })
      return { rows: toRegisterRows('absence', data) }
    }
    const data = await fetchAllRows<{ work_date: string; carried_to_run_id: string | null }>(({ from, to }) =>
      supabase
        .from('salary_worked_days')
        .select('work_date, carried_to_run_id')
        .eq('company_id', companyId)
        .eq('employee_id', args.employeeId)
        .gte('work_date', args.from)
        .lte('work_date', args.to)
        // (employee_id, work_date) is unique.
        .order('work_date')
        .range(from, to),
    )
    return { rows: toRegisterRows('worked', data) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** The employee's payslip on a run, with the pay type the calculation prices. */
type RunPayslip = {
  salary_run_id: string
  salary_type?: string | null
  employee?: { salary_type?: string | null } | null
}

/** The employee's payslips on the given runs, by run id. */
async function loadPayslips(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
  runIds: string[],
): Promise<{ slips: Map<string, RunPayslip> } | { error: string }> {
  if (runIds.length === 0) return { slips: new Map() }
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('salary_run_id, salary_type, employee:employees(salary_type)')
    .eq('company_id', companyId)
    .eq('employee_id', employeeId)
    .in('salary_run_id', runIds)
  if (error) return { error: error.message }
  const rows = (Array.isArray(data) ? data : []) as RunPayslip[]
  return { slips: new Map(rows.map((row) => [row.salary_run_id, row])) }
}

/**
 * Whether the run named for the late days can take them: a draft of the
 * company, later than every late day, with the employee on it, paying the
 * employee the same way as the period each day belongs to. An ordinary run
 * must be the run nextUnsettledRun names. A correction draft is taken for
 * absence when named, while its period's AGI is not at Skatteverket and the
 * paid run it replaces carried a deduction typed by hand for the employee.
 * `periodRuns`: per late day, the run that read it. `payslips`: the
 * employee's payslips on the runs that could take the days and on those.
 */
async function checkLaterRun(
  supabase: SupabaseClient,
  companyId: string,
  runs: CompanyRun[],
  args: {
    kind: RegisterKind
    employeeId: string
    carriedToRunId: string
    lateDates: string[]
    periodRuns: Map<string, CompanyRun>
    payslips: Map<string, RunPayslip>
    absenceType?: string
  },
): Promise<RegisterLockFailure | null> {
  const target = runs.find((run) => run.id === args.carriedToRunId)
  const lastDate = args.lateDates[args.lateDates.length - 1]
  const onRoster = new Set(args.payslips.keys())
  const invalid = (
    reason: LateDayRefusalReason,
    extra: { laterRun?: CompanyRun | null; periodRun?: CompanyRun } = {},
  ): RegisterLockFailure => ({
    ok: false,
    code: SALARY_REGISTER_LATE_DAY_REFUSED,
    details: {
      carried_to_run_id: args.carriedToRunId,
      reason,
      late_dates: args.lateDates,
      ...(target ? { salary_run: refOf(target) } : {}),
      ...(extra.laterRun !== undefined ? { later_salary_run: extra.laterRun ? refOf(extra.laterRun) : null } : {}),
      ...(extra.periodRun ? { period_salary_run: refOf(extra.periodRun) } : {}),
    },
  })
  if (!target) return invalid('not_found')
  if (target.status !== 'draft') {
    // A paid, declared or corrected run takes no late day at all, and cannot
    // go back to draft: name the run that takes them.
    if (runIsSettled(target)) return invalid('not_next', { laterRun: nextUnsettledRun(runs, lastDate, onRoster) })
    return invalid('not_draft')
  }
  if (windowOf(target).start <= lastDate) return invalid('not_later')
  if (target.corrects_run_id) {
    // The opt-in for a deduction already typed by hand into the paid run
    // (late-days.ts): absence only, never into a rättelse.
    const laterRun = () => nextUnsettledRun(runs, lastDate, onRoster)
    if (args.kind !== 'absence') return invalid('correction_without_hand_deduction', { laterRun: laterRun() })
    const filed = await correctionPeriodFiled(supabase, companyId, target, runs)
    if (!filed.ok) return internal(filed.message)
    if (filed.filed) return invalid('correction_period_filed', { laterRun: laterRun() })
    const hand = await paidRunHasHandDeduction(supabase, companyId, target.corrects_run_id, args.employeeId)
    if (!hand.ok) return internal(hand.message)
    if (!hand.found) return invalid('correction_without_hand_deduction', { laterRun: laterRun() })
  } else {
    for (const date of args.lateDates) {
      const next = nextUnsettledRun(runs, date, onRoster)
      if (next?.id !== target.id) return invalid('not_next', { laterRun: next })
    }
  }
  const payslip = args.payslips.get(target.id)
  if (!payslip) return invalid('employee_not_on_run')
  // The employee's own pay type, as the calculation prices it, else the payslip's.
  const payType = payslip.employee?.salary_type ?? payslip.salary_type ?? null

  // What a late day settles is what its own period paid: a full monthly
  // salary to deduct from, or hours never paid. The payslip of the run that
  // read the day says which. Priced under the other pay type, a late sick day
  // would pay sjuklön on top of a full salary, or deduct from one never paid.
  const periodRunIds = Array.from(new Set(Array.from(args.periodRuns.values()).map((run) => run.id)))
  for (const runId of periodRunIds) {
    const periodRun = runs.find((run) => run.id === runId)
    const slip = args.payslips.get(runId)
    if (!slip) {
      // Hours nobody paid are owed; absence from pay nobody paid settles nothing.
      if (args.kind === 'absence') return invalid('not_paid_then', { periodRun })
      continue
    }
    if (slip.salary_type && payType && slip.salary_type !== payType) return invalid('pay_type_changed', { periodRun })
  }

  // Hourly pay deducts nothing for a VAB or parental day: the frånvarouppgift
  // of a late one has no later period (late-days.ts).
  if (args.absenceType && FRANVARO_ABSENCE_TYPES.includes(args.absenceType) && payType === 'hourly') {
    return invalid('hourly_pay')
  }

  // The calendar convention prices an episode from its full length within
  // one window: a late day of a type it prices cannot join one. Refused here
  // so the day is not registered for a calculation that would refuse it.
  if (args.absenceType && CALENDAR_PRICED_ABSENCE_TYPES.includes(args.absenceType)) {
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('salary_calculation_policy')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settingsError) return internal(settingsError.message)
    const policy = SalaryCalculationPolicySchema.safeParse(
      (settings as { salary_calculation_policy?: unknown } | null)?.salary_calculation_policy ?? {},
    ).data
    if (policy?.long_leave === 'calendar_after_five_workdays') return invalid('calendar_long_leave')
  }
  return null
}

/**
 * Decide what an upsert of the given days stores, or refuse it. A day already
 * registered keeps its carry; a new day on a date a paid or declared run read
 * is a late day and needs `carriedToRunId`; every other day is read by its
 * window. `carriedToRunId` changes nothing but late days, so a door that
 * knows the run the user works in may always pass it.
 *
 * An empty date list never queries: nothing to lock.
 */
export async function planRegisterUpsert(
  supabase: SupabaseClient,
  companyId: string,
  args: {
    kind: RegisterKind
    employeeId: string
    dates: readonly string[]
    /** Absence only: the natural key is (employee, date, type). */
    absenceType?: string
    /** The later run (a draft) that takes the late days among the dates. */
    carriedToRunId?: string | null
  },
): Promise<RegisterUpsertPlanResult> {
  const dates = Array.from(new Set(args.dates)).sort()
  const plan: RegisterUpsertPlan = { carriedTo: new Map(), carriedReaderRunIds: [] }
  if (dates.length === 0) return { ok: true, plan }

  const loaded = await loadCompanyRuns(supabase, companyId)
  if ('error' in loaded) return internal(loaded.error)
  const { runs } = loaded
  const employeeRunsLoad = await loadEmployeeRuns(supabase, companyId, args.employeeId)
  if ('error' in employeeRunsLoad) return internal(employeeRunsLoad.error)
  const employeeRuns = employeeRunsLoad.runs

  const existing = await loadExistingRows(supabase, companyId, {
    kind: args.kind,
    employeeId: args.employeeId,
    dates,
    absenceType: args.absenceType,
  })
  if ('error' in existing) return internal(existing.error)
  const existingByDate = new Map(existing.rows.map((row) => [row.date, row]))

  // The corrected runs holding a new day, and which of them paid the employee.
  const correctedIds = new Set<string>()
  for (const date of dates) {
    if (existingByDate.has(date)) continue
    for (const corrected of correctedWindowRuns(runs, date)) correctedIds.add(corrected.id)
  }
  const paidByCorrected = new Set<string>()
  if (correctedIds.size > 0) {
    const { data: slips, error: slipsError } = await supabase
      .from('salary_run_employees')
      .select('salary_run_id')
      .eq('company_id', companyId)
      .eq('employee_id', args.employeeId)
      .in('salary_run_id', Array.from(correctedIds))
    if (slipsError) return internal(slipsError.message)
    for (const slip of (Array.isArray(slips) ? slips : []) as Array<{ salary_run_id: string }>) {
      paidByCorrected.add(slip.salary_run_id)
    }
  }

  const refusals: Refusal[] = []
  const lateDates: string[] = []
  // Per late day, the run that read it: its payslip says what was paid.
  const periodRuns = new Map<string, CompanyRun>()
  const readers = new Set<string>()
  // Absence days between two windows (gapPeriodRun), decided once the
  // payslips are read. `existing`: registered already, carried nowhere.
  const gapDays = new Map<string, { run: CompanyRun; versions: CompanyRun[]; existing: boolean }>()
  for (const date of dates) {
    const row = existingByDate.get(date)
    if (row) {
      const refusal = rowRefusal(runs, row, employeeRuns)
      if (refusal) {
        refusals.push(refusal)
        continue
      }
      // A day registered between the windows before the run after them
      // settled is read by no run: naming a later run carries it there.
      const gap = !row.carried_to_run_id && args.kind === 'absence' && args.carriedToRunId ? gapPeriodRun(runs, date) : null
      if (gap) {
        gapDays.set(date, { ...gap, existing: true })
        continue
      }
      plan.carriedTo.set(date, row.carried_to_run_id)
      const reader = row.carried_to_run_id ? liveCarriedReader(runs, row.carried_to_run_id) : null
      if (reader) readers.add(reader.id)
      continue
    }
    const run = newDayWindowRun(runs, date, paidByCorrected, employeeRuns)
    if (!run) {
      const gap = args.kind === 'absence' ? gapPeriodRun(runs, date) : null
      if (gap) gapDays.set(date, { ...gap, existing: false })
      else plan.carriedTo.set(date, null)
      continue
    }
    if (!runIsSettled(run)) {
      refusals.push({ run, date, reason: 'run_not_settled' })
      continue
    }
    if (!args.carriedToRunId) {
      refusals.push({ run, date, reason: 'late_day_needs_later_run' })
      continue
    }
    lateDates.push(date)
    periodRuns.set(date, run)
  }

  // Where late days go depends on whose payslips the runs hold: read the
  // employee's on every run that could take them and on those that read them.
  let payslips = new Map<string, RunPayslip>()
  if (lateDates.length > 0 || gapDays.size > 0 || refusals.some((refusal) => refusal.reason === 'late_day_needs_later_run')) {
    const ids = new Set<string>()
    for (const run of runs) if (!runIsSettled(run)) ids.add(run.id)
    for (const run of periodRuns.values()) ids.add(run.id)
    for (const gap of gapDays.values()) for (const version of gap.versions) ids.add(version.id)
    const loadedSlips = await loadPayslips(supabase, companyId, args.employeeId, Array.from(ids))
    if ('error' in loadedSlips) return internal(loadedSlips.error)
    payslips = loadedSlips.slips
  }

  // A day between the windows is late only when its pay month paid the
  // employee a monthly salary: that is what the day's absence should have
  // reduced. Hourly pay, or no payslip then, leaves it as before. A settled
  // correction that left off an employee an earlier version paid monthly
  // paid them nothing to deduct from; what went out before is an
  // overpayment handled by hand (payable.ts). The day is then a late day of
  // the correction, as in a window, which checkLaterRun refuses
  // (not_paid_then).
  for (const [date, gap] of gapDays) {
    const slip = payslips.get(gap.run.id)
    const paidMonthly = slip
      ? slipPayType(slip) === 'monthly'
      : gap.versions.some((version) => slipPayType(payslips.get(version.id)) === 'monthly')
    if (!paidMonthly) {
      plan.carriedTo.set(date, null)
      continue
    }
    if (!args.carriedToRunId) {
      refusals.push({ run: gap.run, date, reason: 'late_day_needs_later_run' })
      continue
    }
    lateDates.push(date)
    periodRuns.set(date, gap.run)
  }
  lateDates.sort()

  const locked = lockFailure(refusals, runs, new Set(payslips.keys()))
  if (locked) return locked

  if (lateDates.length > 0 && args.carriedToRunId) {
    const invalid = await checkLaterRun(supabase, companyId, runs, {
      kind: args.kind,
      employeeId: args.employeeId,
      carriedToRunId: args.carriedToRunId,
      lateDates,
      periodRuns,
      payslips,
      absenceType: args.kind === 'absence' ? args.absenceType : undefined,
    })
    if (invalid) return invalid
    for (const date of lateDates) plan.carriedTo.set(date, args.carriedToRunId)
    readers.add(args.carriedToRunId)
  }

  plan.carriedReaderRunIds = Array.from(readers)
  return { ok: true, plan }
}

/**
 * Whether a range delete may remove the rows it reaches: refused when a run
 * in a locking status reads any of them, through a carry or through its
 * window. Judged by the rows, so a range with nothing registered on a locked
 * date deletes nothing and is not refused.
 */
export async function checkRegisterRangeDelete(
  supabase: SupabaseClient,
  companyId: string,
  args: { kind: RegisterKind; employeeId: string; from: string; to: string; absenceType?: string },
): Promise<RegisterDeleteCheckResult> {
  const loadedRows = await loadRangeRows(supabase, companyId, args)
  if ('error' in loadedRows) return internal(loadedRows.error)
  if (loadedRows.rows.length === 0) return { ok: true, carriedReaderRunIds: [] }

  const loaded = await loadCompanyRuns(supabase, companyId)
  if ('error' in loaded) return internal(loaded.error)
  const { runs } = loaded
  const employeeRunsLoad = await loadEmployeeRuns(supabase, companyId, args.employeeId)
  if ('error' in employeeRunsLoad) return internal(employeeRunsLoad.error)

  const refusals: Refusal[] = []
  const readers = new Set<string>()
  for (const row of loadedRows.rows) {
    const refusal = rowRefusal(runs, row, employeeRunsLoad.runs)
    if (refusal) {
      refusals.push(refusal)
      continue
    }
    const reader = row.carried_to_run_id ? liveCarriedReader(runs, row.carried_to_run_id) : null
    if (reader) readers.add(reader.id)
  }
  const locked = lockFailure(refusals, runs, new Set())
  if (locked) return locked
  return { ok: true, carriedReaderRunIds: Array.from(readers) }
}
