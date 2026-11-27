/**
 * Late days: register days a later salary run settles.
 *
 * A row in salary_absence_days or salary_worked_days is read by the run whose
 * avvikelseperiod holds its date (lib/salary/deviation-period.ts). A day that
 * becomes known after that run was paid or its arbetsgivardeklaration filed
 * cannot go there any more. Its pay is out, and frånvarouppgifter are filed
 * only with a period's first declaration: "Ändrade eller tillagda
 * frånvarouppgifter kommer inte kunna skickas in i samband med rättelse av en
 * arbetsgivardeklaration och ska heller inte skickas in i samband med
 * arbetsgivardeklaration för en senare redovisningsperiod" (Skatteverket,
 * Teknisk beskrivning 1.1.18.2, 9.3). That sentence is about uppgifter that
 * belong to the earlier period. A day nobody deducted affected no pay then:
 * the full pay went out. It affects the pay that deducts it, and "Frånvaro ska
 * redovisas samma redovisningsperiod som ersättningen som påverkas av
 * frånvaron redovisas" (TB 1.1.18.2, 5.6; lag 2024:1300 2-3 §§; Försäkringskassan,
 * "Redovisa frånvarouppgifter för föräldraledighet och vab": absence in January
 * deducted from February's pay is reported for February). Skatteverket's own
 * example of pay that went out in full despite absence settles it on the next
 * payout: March stays as paid, April is declared at the lower amount, with
 * tax on it (Skatteverket, "Rätta en arbetsgivardeklaration", kvittning).
 *
 * So the day is registered on its real date and carried to the next run that
 * is not yet paid or declared (carried_to_run_id, migration 20261125183000).
 * That run deducts or pays it like one of its own days, shows the dates on the
 * payslip and puts its frånvarouppgifter in its own AGI. A rättelsekörning of
 * the paid run stays the path for an error found before payout and AGI.
 *
 * A correction run is never where a late day goes by default. Its original's
 * pay went out in full, so a deduction there would declare less than was paid
 * and recover nothing (Skatteverket allows kvittning on a later payout, or an
 * återkrav that leaves the skatteavdrag as it was). It takes late days only
 * when named, only for absence, only while its period's AGI is not at
 * Skatteverket (correctionPeriodFiled), and only when the paid run carried a
 * deduction typed by hand for the employee (paidRunHasHandDeduction): the
 * correction replaces that line with the registered days, so the pay stays
 * as paid and their frånvarouppgifter reach that period's first declaration.
 *
 * The frånvarouppgift follows a deduction. Hourly pay has none to make: the
 * hours not worked were never paid, so the absence affected the pay of its
 * own period, and that is where its uppgift belonged (TB 1.1.18.2, 8.4). A
 * late VAB or parental day of an hourly employee, or one a run with no
 * monthly salary would deduct nothing for, is therefore refused rather than
 * reported in a later period (9.3).
 *
 * The one reading rule, used by the calculation, the AGI and the payslip:
 * a run reads the rows inside its window that are carried nowhere, and every
 * row carried to it or to a run it corrects (a correction run re-reads the
 * days its original was given). A row carried elsewhere is never read by a
 * window. When a day may be carried, and to which run, is the register
 * lock's (lib/salary/register-locks.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { AGI_RECEIPT_STATUSES } from '@/lib/deadlines/agi-filed'
import { agiReportingPeriod } from '@/lib/deadlines/agi-reporting-period'
import { isSwedishHolidayISO } from '@/lib/tax/swedish-holidays'

/** The later run that takes late days: the same request field on every register write door. */
export const CarriedToRunIdSchema = z
  .string()
  .uuid()
  .describe(
    'For days on dates a paid, booked or declared salary run already read, or a monthly-paid employee\'s absence between two runs\' windows behind one (late days): the next ordinary salary run that is neither paid nor declared, a draft with the employee on it. It deducts or pays them, shows them on the payslip and reports them in its AGI. A correction draft is taken only when named, and only while its period\'s AGI is not filed. Other days ignore it.',
  )

/**
 * A run whose pay is out (paid, booked, or booked and since corrected) or
 * whose AGI is filed. Whatever it read is settled: a day it should have had
 * is carried to a later run. Only a booked run can be corrected, so a
 * correction never reopens its original's window for a new day.
 */
export function runIsSettled(run: { status: string; agi_submitted_at?: string | null }): boolean {
  return run.status === 'paid' || run.status === 'booked' || run.status === 'corrected' || Boolean(run.agi_submitted_at)
}

/** A run as the correction chain is followed: its id, its filing and the run it corrects. */
type ChainRun = { id: string; agi_submitted_at?: string | null; corrects_run_id?: string | null }

/** A correction run as correctionPeriodFiled reads it. */
type CorrectionRun = ChainRun & { payment_date?: string | null; period_year: number; period_month: number }

/**
 * agi_declarations states in which the period's declaration is at
 * Skatteverket: awaiting signature in Mina sidor, or filed with a receipt.
 */
const AGI_AT_SKATTEVERKET_STATUSES: readonly string[] = ['pending_signature', ...AGI_RECEIPT_STATUSES]

/**
 * Whether the period a correction run declares already has its first
 * declaration at Skatteverket: a run in the chain it corrects carries a
 * receipt (agi_submitted_at), the period's declaration awaits signature or is
 * filed, or its AGI deadline is marked done (a declaration filed outside the
 * app). The correction's AGI is then a rättelse, and frånvarouppgifter cannot
 * be added to one: "Ändrade eller tillagda frånvarouppgifter kommer inte kunna
 * skickas in i samband med rättelse av en arbetsgivardeklaration" (TB
 * 1.1.18.2, 9.3); "Frånvarouppgifter får inte finnas för RedovisningsPeriod,
 * FK006, där första deklaration redan har skickats in" (Kontroller 1.1.18.1,
 * ba_824). `runs` are the company's runs, where the chain is looked up.
 */
export async function correctionPeriodFiled(
  supabase: SupabaseClient,
  companyId: string,
  run: CorrectionRun,
  runs: readonly ChainRun[],
): Promise<{ ok: true; filed: boolean } | { ok: false; message: string }> {
  const seen = new Set<string>()
  let current: ChainRun | undefined = run
  while (current && !seen.has(current.id)) {
    if (current.agi_submitted_at) return { ok: true, filed: true }
    seen.add(current.id)
    const correctedId: string | null | undefined = current.corrects_run_id
    current = correctedId ? runs.find((r) => r.id === correctedId) : undefined
  }
  const { periodYear, periodMonth } = agiReportingPeriod(run)
  const [declaration, deadline] = await Promise.all([
    supabase
      .from('agi_declarations')
      .select('status')
      .eq('company_id', companyId)
      .eq('period_year', periodYear)
      .eq('period_month', periodMonth)
      .maybeSingle(),
    supabase
      .from('deadlines')
      .select('is_completed')
      .eq('company_id', companyId)
      .eq('tax_deadline_type', 'arbetsgivardeklaration')
      .eq('tax_period', `${periodYear}-${String(periodMonth).padStart(2, '0')}`)
      .is('dismissed_at', null),
  ])
  const error = declaration.error ?? deadline.error
  if (error) return { ok: false, message: error.message }
  const status = (declaration.data as { status?: string } | null)?.status
  const deadlineDone = ((deadline.data ?? []) as Array<{ is_completed: boolean | null }>).some(
    (row) => row.is_completed === true,
  )
  return { ok: true, filed: (status != null && AGI_AT_SKATTEVERKET_STATUSES.includes(status)) || deadlineDone }
}

/**
 * Manual line types that lower the gross pay: the ways a deduction for
 * missed days is typed by hand on a payslip (manual-payslip-lines.ts).
 */
const HAND_DEDUCTION_ITEM_TYPES: readonly string[] = ['gross_deduction_other', 'correction']

/**
 * A payslip line that is a deduction typed by hand: a negative Bruttolöneavdrag
 * or Korrigering that no förmån or recurring line wrote. The correction a late
 * day is carried to copies it from the paid run, so the calculation names it:
 * left in place, it deducts the same days a second time.
 */
export function isHandDeductionLine(line: {
  item_type?: unknown
  amount?: unknown
  source_benefit_id?: unknown
  source_recurring_line_id?: unknown
}): boolean {
  return (
    typeof line.item_type === 'string' &&
    HAND_DEDUCTION_ITEM_TYPES.includes(line.item_type) &&
    Number(line.amount) < 0 &&
    !line.source_benefit_id &&
    !line.source_recurring_line_id
  )
}

/**
 * Whether the paid run a correction replaces carried a deduction typed by
 * hand on the employee's payslip: a negative Bruttolöneavdrag or Korrigering
 * that no förmån or recurring line wrote. That is the one case a correction
 * takes late days for: it replaces the hand line with the registered days, so
 * the pay stays as paid and their frånvarouppgifter reach the period's first
 * declaration. Without one the days belong to the next ordinary run.
 */
export async function paidRunHasHandDeduction(
  supabase: SupabaseClient,
  companyId: string,
  paidRunId: string,
  employeeId: string,
): Promise<{ ok: true; found: boolean } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('id, line_items:salary_line_items(item_type, amount, source_benefit_id, source_recurring_line_id)')
    .eq('company_id', companyId)
    .eq('salary_run_id', paidRunId)
    .eq('employee_id', employeeId)
    .maybeSingle()
  if (error) return { ok: false, message: error.message }
  const lines = (data as { line_items?: unknown } | null)?.line_items
  const found = (Array.isArray(lines) ? (lines as Array<Record<string, unknown>>) : []).some(isHandDeductionLine)
  return { ok: true, found }
}

/**
 * The absence types the AGI reports as frånvarouppgifter (absence that can
 * give föräldrapenning or tillfällig föräldrapenning, lag 2024:1300 2 §).
 * generate-declaration.ts reads these.
 */
export const FRANVARO_ABSENCE_TYPES: readonly string[] = ['vab', 'parental']

/**
 * Absence types the calendar convention (long_leave =
 * calendar_after_five_workdays, calendar-leave.ts) prices from an episode's
 * full length within one window. A late day of these types cannot join an
 * episode there, so under that convention it is refused, at registration and
 * in the calculation.
 */
export const CALENDAR_PRICED_ABSENCE_TYPES: readonly string[] = ['parental', 'unpaid_leave', 'sick']

/** Longest correction chain followed before the data is treated as broken. */
const MAX_CHAIN_DEPTH = 50

/**
 * The run ids whose carried rows `run` reads: the run itself, then every run
 * it corrects, nearest first. An ordinary run answers without a query.
 */
export async function lateDayReaderRunIds(
  supabase: SupabaseClient,
  companyId: string,
  run: { id: string; corrects_run_id?: string | null },
): Promise<string[]> {
  const ids = [run.id]
  let next = run.corrects_run_id ?? null
  while (next) {
    if (ids.includes(next) || ids.length > MAX_CHAIN_DEPTH) {
      throw new Error(`salary run ${run.id}: the chain of corrected runs does not end`)
    }
    const current: string = next
    const { data, error } = await supabase
      .from('salary_runs')
      .select('id, corrects_run_id')
      .eq('id', current)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw new Error(`Failed to load corrected salary run: ${error.message}`)
    if (!data) throw new Error(`salary run ${run.id}: corrected run ${current} not found`)
    ids.push(current)
    next = (data as { corrects_run_id: string | null }).corrects_run_id ?? null
  }
  return ids
}

/**
 * The dates of an employee's days carried to any of `runIds` (a run and the
 * runs it corrects, lateDayReaderRunIds), in both registers, sorted. That run
 * is their only reader: it cannot drop the employee while they are there.
 */
export async function lateDaysCarriedTo(
  supabase: SupabaseClient,
  companyId: string,
  employeeId: string,
  runIds: readonly string[],
): Promise<{ ok: true; dates: string[] } | { ok: false; message: string }> {
  if (runIds.length === 0) return { ok: true, dates: [] }
  const [absence, worked] = await Promise.all([
    supabase
      .from('salary_absence_days')
      .select('absence_date')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .in('carried_to_run_id', [...runIds]),
    supabase
      .from('salary_worked_days')
      .select('work_date')
      .eq('company_id', companyId)
      .eq('employee_id', employeeId)
      .in('carried_to_run_id', [...runIds]),
  ])
  const error = absence.error ?? worked.error
  if (error) return { ok: false, message: error.message }
  const dates = [
    ...((absence.data ?? []) as Array<{ absence_date: string }>).map((row) => row.absence_date),
    ...((worked.data ?? []) as Array<{ work_date: string }>).map((row) => row.work_date),
  ]
  return { ok: true, dates: [...new Set(dates)].sort() }
}

/**
 * The ordinary run a payslip (salary_run_employees.id) belongs to. The
 * dashboard's calendar on a payslip names the payslip a day is registered
 * from; its run is the run the user works in, so it takes the late days
 * registered there. A correction's payslip answers null: a correction takes
 * late days only when named on purpose, to replace a deduction typed by hand
 * into the paid run, and a click in its calendar is not that. Null too
 * without a payslip or when it cannot be read: late days are then refused,
 * naming the run they go to, as they are without a run.
 */
export async function runOfPayslip(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunEmployeeId: string | null | undefined,
): Promise<string | null> {
  if (!salaryRunEmployeeId) return null
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select('salary_run_id, salary_run:salary_runs(corrects_run_id)')
    .eq('id', salaryRunEmployeeId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !data) return null
  const payslip = data as { salary_run_id: string; salary_run?: { corrects_run_id?: string | null } | null }
  return payslip.salary_run?.corrects_run_id ? null : payslip.salary_run_id
}

/**
 * Whether a register row belongs to the run whose reader ids are given. A
 * carried row belongs only to the run it is carried to; any other row belongs
 * to the run whose window holds its date (`inWindow`).
 */
export function registerRowReadByRun(
  row: { carried_to_run_id?: string | null },
  readerRunIds: readonly string[],
  inWindow: boolean,
): boolean {
  if (row.carried_to_run_id) return readerRunIds.includes(row.carried_to_run_id)
  return inWindow
}

function isWorkday(iso: string): boolean {
  const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6 && !isSwedishHolidayISO(iso)
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Dates as the payslip prints them: consecutive days as one span, where a
 * weekend or a public holiday in between does not break it ("2026-10-12 till
 * 2026-10-30", "2026-10-05, 2026-10-07").
 */
export function describeLateDates(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort()
  const spans: Array<[string, string]> = []
  for (const date of sorted) {
    const last = spans[spans.length - 1]
    if (last) {
      let gapHasWorkday = false
      for (let d = nextDay(last[1]); d < date; d = nextDay(d)) {
        if (isWorkday(d)) {
          gapHasWorkday = true
          break
        }
      }
      if (!gapHasWorkday) {
        last[1] = date
        continue
      }
    }
    spans.push([date, date])
  }
  return spans.map(([from, to]) => (from === to ? from : `${from} till ${to}`)).join(', ')
}

/**
 * The words a payslip line gets when some of its days come from an earlier
 * period: the employee otherwise cannot tell why October's leave sits on the
 * December payslip. `allLate`: every day of the line is a late day.
 */
export function lateDaysSuffix(lateDates: readonly string[], allLate: boolean): string {
  if (lateDates.length === 0) return ''
  return `, ${allLate ? '' : 'varav '}från tidigare period: ${describeLateDates(lateDates)}`
}
