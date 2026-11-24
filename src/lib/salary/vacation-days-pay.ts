/**
 * Pay derived from vacation days taken (issue #85).
 *
 * A vacation payslip line (item_type 'vacation', quantity = days off,
 * vacation_category = which days) used to record days only: the monthly
 * salary ran on under every rule and nothing else changed, so a
 * semestertillägg had to be typed by hand. This module prices the days of
 * every vacation line that carries no amount. A line with an amount is the
 * operator's own pricing (a kollektivavtal may deviate from 16-16 b §§ and
 * 26 §, Semesterlagen 2 a § andra stycket) and is left as it is.
 *
 * Statute: Semesterlagen (1977:480), riksdagen.se, read 2026-10-23. The
 * decisions and their sources: docs/research/payroll-semester-derived-pay.md.
 *
 *   sammalöneregeln (16 a §): the monthly salary runs on; a semestertillägg
 *     "för varje betald semesterdag" of the employee's rate (0,43 % by law,
 *     employees.semestertillagg_rate, the field the accrual reads) of the
 *     månadslön at the employment degree.
 *   procentregeln (16 b §, 22 §): the salary for the days goes (one dagslön
 *     per day off, the engine's day: månadslön / dagdivisor) and the
 *     semesterlön comes, per paid day the rate of the previous year's
 *     semesterlönegrundande lön divided by the paid days earned in it
 *     (procentregelnDayValue below). Hourly pay: the semesterlön only.
 *   obetalda dagar (8 §): one dagslön per day off, monthly pay only.
 *   förskott: the monthly salary runs on, nothing is derived.
 *
 * Paid days, not days off, carry the tillägg and the semesterlön: on a short
 * week each day off uses more than one paid day (12 a §,
 * vacation-net-days.ts). A deduction is per day off: it takes back the
 * salary of the days the employee is away.
 *
 * Whatever cannot be priced from the law and the data (no base year in
 * Accounted, hourly pay on sammalöneregeln, hourly förskott, vacation pay
 * already paid as semesterersättning) is refused with a reason that says
 * what to do, never priced by a guess.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre, sumOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { CalculationStep } from './calculation-engine'
import { isCalculatedLine } from './calculated-line-items'
import { paidDaysEarnedIn } from './vacation-ledger'
import { roundPaidDays } from './vacation-net-days'
import { resolveVacationPayRate } from './vacation-pay-rate'
import { getVacationYearBounds, getVacationYearStart, type VacationYearBasis } from './vacation-year'
import { previousVacationYearStart, vacationYearLabel } from './variable-vacation-pay'

/** A reason in both languages: Swedish for the person, English for an agent. */
export interface VacationPayReason {
  sv: string
  en: string
}

// ============================================================
// Which lines are priced
// ============================================================

/** A stored payslip line, as far as this module reads it. */
export interface VacationLineInput {
  item_type?: unknown
  quantity?: unknown
  amount?: unknown
  vacation_category?: unknown
  calculation_source?: unknown
  source_benefit_id?: unknown
  source_recurring_line_id?: unknown
}

/**
 * True for a vacation line the calculation prices: entered by hand, days in
 * quantity, no amount. A line with an amount says what the payslip pays for
 * the days, and an engine row is never an input.
 */
export function isDaysOnlyVacationLine(line: VacationLineInput): boolean {
  if (line.item_type !== 'vacation' || isCalculatedLine(line)) return false
  const days = Number(line.quantity)
  return Number.isFinite(days) && days > 0 && Number(line.amount || 0) === 0
}

/** Days off per kind, from the days-only vacation lines of one payslip. */
export interface VacationDaysOff {
  /** Betalda (paid, and lines without a category). */
  paid: number
  /** Extra betalda: paid days above the statutory 25, in the same pool. */
  extraPaid: number
  /** Sparade: valued as earned in the most recent intjänandeår (22 §). */
  saved: number
  unpaid: number
  advance: number
}

export function vacationDaysOff(lines: readonly VacationLineInput[]): VacationDaysOff {
  const days: VacationDaysOff = { paid: 0, extraPaid: 0, saved: 0, unpaid: 0, advance: 0 }
  for (const line of lines) {
    if (!isDaysOnlyVacationLine(line)) continue
    const n = Number(line.quantity)
    switch (line.vacation_category) {
      case 'extra_paid':
        days.extraPaid = roundPaidDays(days.extraPaid + n)
        break
      case 'saved':
        days.saved = roundPaidDays(days.saved + n)
        break
      case 'unpaid':
        days.unpaid = roundPaidDays(days.unpaid + n)
        break
      case 'advance':
        days.advance = roundPaidDays(days.advance + n)
        break
      default:
        // paid and NULL (every line written before categories existed).
        days.paid = roundPaidDays(days.paid + n)
    }
  }
  return days
}

/** Days off that are paid vacation: betalda, extra betalda and sparade. */
export function paidLikeDaysOff(days: VacationDaysOff): number {
  return roundPaidDays(days.paid + days.extraPaid + days.saved)
}

// ============================================================
// Procentregeln: the value of one paid day
// ============================================================

/** One of the employee's payslips, reduced to what the base reads. */
export interface ProcentregelnBasisPayslip {
  salaryRunId: string
  paymentDate: string
  status: string
  /** The semesterunderlag the payslip accrued 12 % on, or null when it was not calculated under procentregeln. */
  vacationBasis: number | null
}

/** Run statuses whose pay has fallen due (the YTD rule; variable-vacation-pay.ts). */
const DUE_STATUSES: ReadonlySet<string> = new Set(['approved', 'paid', 'booked'])

/**
 * The semesterunderlag a stored breakdown accrued on under procentregeln:
 * the input of its "Semesteravsättning (procentregeln ...)" step
 * (calculation-engine.ts step 9), the same figure the 2920 accrual was
 * booked from. null when the payslip was calculated under another rule.
 */
export function procentregelnBasisFromBreakdown(breakdown: unknown): number | null {
  const steps = (breakdown as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return null
  for (const step of steps) {
    const label = (step as { label?: unknown } | null)?.label
    if (typeof label !== 'string' || !label.startsWith('Semesteravsättning (procentregeln')) continue
    const basis = Number((step as { input?: Record<string, unknown> }).input?.vacation_basis)
    return Number.isFinite(basis) ? basis : null
  }
  return null
}

export type ProcentregelnDayValue =
  | {
      known: true
      /** The year the base is taken from: the intjänandeår, or the previous calendar year. */
      yearStart: string
      yearLabel: string
      /** Sum of the year's semesterunderlag (16 b § första stycket). */
      base: number
      /** resolveVacationPayRate: 12 %, 14,4 % at 30 days, or a higher kollektivavtal rate. */
      rate: number
      /** Paid days earned in the year (7 §). */
      earnedDays: number
      payslips: number
      /** One paid day: rate × base / earned days, rounded to öre. */
      perDay: number
    }
  | { known: false; reason: VacationPayReason }

function monthsBetween(fromIso: string, toIso: string): string[] {
  const months: string[] = []
  let year = Number(fromIso.slice(0, 4))
  let month = Number(fromIso.slice(5, 7))
  const lastYear = Number(toIso.slice(0, 4))
  const lastMonth = Number(toIso.slice(5, 7))
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return months
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function describeMonths(months: readonly string[], lang: 'sv' | 'en'): string {
  if (months.length <= 3) return months.join(', ')
  const first = months[0]
  const last = months[months.length - 1]
  return lang === 'sv'
    ? `${months.length} månader mellan ${first} och ${last}`
    : `${months.length} months between ${first} and ${last}`
}

const PRICE_IT_YOURSELF_SV =
  'Ange semesterlönen själv på semesterraden (belopp, eller antal och à-pris), eller registrera dagarna som obetalda eller förskott, och beräkna om.'
const PRICE_IT_YOURSELF_EN =
  'Put the semesterlön on the vacation line yourself (amount, or quantity and unit_price), or register the days as unpaid or advance, then calculate again.'

/**
 * What one paid vacation day is worth under procentregeln for a payslip paid
 * on `paymentDate`, from the employee's payslips of the year before.
 *
 * Semesterlagen 16 b § första stycket: twelve per cent of the pay that fell
 * due in the intjänandeår; 7 §: the paid days that year earns; 22 §: saved
 * days count as earned in the most recent intjänandeår. The base year is the
 * vacation year before the one the payment date falls in: under the
 * statutory basis exactly the intjänandeår (3 §); under the calendar basis
 * (sammanfallande semesterår, a kollektivavtal arrangement) the previous
 * calendar year, which has to be a whole year of employment.
 *
 * Known only when Accounted holds the whole year: a counted payslip
 * (approved, paid or booked) calculated under procentregeln in every month
 * the employee was employed. Otherwise the reason names the year, the months
 * and what to do.
 */
export function procentregelnDayValue(input: {
  paymentDate: string
  basis: VacationYearBasis
  employmentStart: string
  employmentEnd: string | null
  vacationDaysPerYear: number
  vacationPayRate: number | null | undefined
  payslips: readonly ProcentregelnBasisPayslip[]
}): ProcentregelnDayValue {
  const currentStart = getVacationYearStart(input.paymentDate, input.basis)
  const yearStart = previousVacationYearStart(currentStart)
  const yearEnd = getVacationYearBounds(yearStart).end
  const yearLabel = vacationYearLabel(yearStart, input.basis)
  const yearName = input.basis === 'calendar' ? `året ${yearLabel}` : `intjänandeåret ${yearLabel}`
  const yearNameEn = input.basis === 'calendar' ? `the year ${yearLabel}` : `the earning year ${yearLabel}`

  const employedFrom = input.employmentStart > yearStart ? input.employmentStart : yearStart
  const lastDay = dayBefore(yearEnd)
  const employedTo = input.employmentEnd && input.employmentEnd < lastDay ? input.employmentEnd : lastDay

  // The base year is an intjänandeår on either basis: on the statutory one
  // the payment's semesterår's, on the calendar one its own (sammanfallande).
  const earnedDays =
    employedFrom > employedTo
      ? 0
      : paidDaysEarnedIn({ start: yearStart, end: yearEnd }, input.vacationDaysPerYear, input.employmentStart)
  if (!(earnedDays > 0)) {
    return {
      known: false,
      reason: {
        sv:
          `inga betalda semesterdagar är intjänade under ${yearName} (anställd från ${input.employmentStart}), ` +
          'så dagarna kan inte betalas med semesterlön (Semesterlagen 7 §). Registrera dem som obetalda eller förskott, ' +
          'eller ange beloppet på semesterraden, och beräkna om.',
        en:
          `no paid vacation days were earned in ${yearNameEn} (employed from ${input.employmentStart}), so the days carry no ` +
          'semesterlön (Semesterlagen 7 §). Register them as unpaid or advance, or put the amount on the vacation line, then calculate again.',
      },
    }
  }
  if (input.basis === 'calendar' && input.employmentStart > yearStart) {
    return {
      known: false,
      reason: {
        sv:
          `semesterlönen enligt procentregeln räknas på ${yearName}, men den anställde var inte anställd hela året ` +
          `(från ${input.employmentStart}). Med sammanfallande semesterår avgör avtalet hur dagarna värderas. ${PRICE_IT_YOURSELF_SV}`,
        en:
          `procentregeln semesterlön is valued on ${yearNameEn}, but the employee was not employed the whole year ` +
          `(from ${input.employmentStart}). With a sammanfallande semesterår the agreement decides how the days are valued. ${PRICE_IT_YOURSELF_EN}`,
      },
    }
  }

  const counted = input.payslips.filter(
    (p) => DUE_STATUSES.has(p.status) && p.paymentDate >= yearStart && p.paymentDate < yearEnd,
  )
  const paidMonths = new Set(counted.map((p) => p.paymentDate.slice(0, 7)))
  const missing = monthsBetween(employedFrom, employedTo).filter((month) => !paidMonths.has(month))
  if (missing.length > 0) {
    return {
      known: false,
      reason: {
        sv:
          `semesterlönen enligt procentregeln är 12 % av lönen under ${yearName} (Semesterlagen 16 b §), ` +
          `men Accounted saknar godkända lönebesked för ${describeMonths(missing, 'sv')}. ${PRICE_IT_YOURSELF_SV}`,
        en:
          `procentregeln semesterlön is 12 % of the pay of ${yearNameEn} (Semesterlagen 16 b §), but Accounted has no ` +
          `approved, paid or booked payslip for ${describeMonths(missing, 'en')}. ${PRICE_IT_YOURSELF_EN}`,
      },
    }
  }
  const otherRule = [...new Set(counted.filter((p) => p.vacationBasis === null).map((p) => p.paymentDate.slice(0, 7)))].sort()
  if (otherRule.length > 0) {
    return {
      known: false,
      reason: {
        sv:
          `semesterlönen enligt procentregeln bygger på lönen under ${yearName}, men lönebeskeden för ` +
          `${describeMonths(otherRule, 'sv')} beräknades inte enligt procentregeln. ${PRICE_IT_YOURSELF_SV}`,
        en:
          `procentregeln semesterlön rests on the pay of ${yearNameEn}, but the payslips of ${describeMonths(otherRule, 'en')} ` +
          `were not calculated under procentregeln. ${PRICE_IT_YOURSELF_EN}`,
      },
    }
  }

  const base = sumOre(counted.map((p) => p.vacationBasis ?? 0))
  const rate = resolveVacationPayRate(input.vacationDaysPerYear, input.vacationPayRate)
  return {
    known: true,
    yearStart,
    yearLabel,
    base,
    rate,
    earnedDays,
    payslips: counted.length,
    perDay: roundOre((rate * base) / earnedDays),
  }
}

interface BasisHistoryRow {
  employee_id: string
  calculation_breakdown: unknown
  salary_run: { id: string; payment_date: string; status: string } | null
}

/**
 * The given employees' payslips paid in [from, to), reduced to their
 * procentregeln semesterunderlag. Paginated and company-scoped;
 * `excludeRunId` leaves out the run being calculated.
 */
export async function loadProcentregelnBasisPayslips(
  supabase: SupabaseClient,
  args: { companyId: string; employeeIds: string[]; from: string; to: string; excludeRunId?: string },
): Promise<Map<string, ProcentregelnBasisPayslip[]>> {
  const byEmployee = new Map<string, ProcentregelnBasisPayslip[]>()
  if (args.employeeIds.length === 0) return byEmployee
  const rows = await fetchAllRows<BasisHistoryRow>(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select('employee_id, calculation_breakdown, salary_run:salary_runs!inner(id, payment_date, status)')
      .eq('company_id', args.companyId)
      .in('employee_id', args.employeeIds)
      .gte('salary_run.payment_date', args.from)
      .lt('salary_run.payment_date', args.to)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: BasisHistoryRow[] | null; error: { message: string } | null }>,
  )
  for (const row of rows) {
    const run = row.salary_run
    if (!run || run.id === args.excludeRunId) continue
    const payslip: ProcentregelnBasisPayslip = {
      salaryRunId: run.id,
      paymentDate: run.payment_date,
      status: run.status,
      vacationBasis: procentregelnBasisFromBreakdown(row.calculation_breakdown),
    }
    const list = byEmployee.get(row.employee_id)
    if (list) list.push(payslip)
    else byEmployee.set(row.employee_id, [payslip])
  }
  return byEmployee
}

// ============================================================
// The derived rows
// ============================================================

export type VacationPayRowKind = 'semestertillagg' | 'semesterloneavdrag' | 'semesterlon' | 'obetald_semester'

/** A row the calculation writes for the days (item_type vacation, calculation_source vacation_pay). */
export interface DerivedVacationPayRow {
  kind: VacationPayRowKind
  /** Swedish, stored on the payslip (stored data stays Swedish). */
  description: string
  amount: number
  /** True when the amount enters the procentregeln base: a deduction of pay never earned. */
  is_vacation_basis: boolean
  /**
   * True on the deductions: they take back salary, so the booking leaves them
   * out of the line accounts and the base-salary remainder carries them on
   * the employee's salary account (salary-entries.ts), as for the sick rows.
   * The engine's Step 3 consumes them as absence and Step 4 never sees them.
   */
  is_gross_deduction: boolean
  sort_order: number
}

export interface DeriveVacationDaysPayInput {
  vacationRule: string
  salaryType: 'monthly' | 'hourly'
  /** The run's monthly salary at the employment degree (the månadslön); ignored for hourly pay. */
  monthlySalary: number
  /** employees.semestertillagg_rate (0,0043 by default). */
  semestertillaggRate: number
  /** dailyDivisor(workdays_per_week): 21 at five days a week. */
  dailyDivisor: number
  /** Paid days one day off uses (vacation-net-days.ts): 1,25 at four days a week. */
  paidDaysPerDayOff: number
  days: VacationDaysOff
  /** Procentregeln only, and only when the payslip has paid days. */
  procentregelnDayValue?: ProcentregelnDayValue
}

export type DeriveVacationDaysPayResult =
  | { ok: true; rows: DerivedVacationPayRow[]; steps: CalculationStep[] }
  | { ok: false; reason: VacationPayReason }

/** Sort order on the payslip: after the semesterersättning rows (50, 51). */
const SORT_ORDER: Record<VacationPayRowKind, number> = {
  semesterloneavdrag: 52,
  semesterlon: 53,
  semestertillagg: 54,
  obetald_semester: 55,
}

function swedishNumber(n: number, decimals: number): string {
  return n
    .toLocaleString('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace(/[  ]/g, ' ')
}

function kr(n: number): string {
  return `${swedishNumber(n, 2)} kr`
}

function pct(rate: number): string {
  return `${roundOre(rate * 10000) / 100}`.replace('.', ',') + ' %'
}

function dayCount(n: number): string {
  return Number.isInteger(n) ? String(n) : swedishNumber(n, 2).replace(/0+$/, '').replace(/,$/, '')
}

function daysText(n: number): string {
  return `${dayCount(n)} ${n === 1 ? 'dag' : 'dagar'}`
}

const SAMMALONE_HOURLY: VacationPayReason = {
  sv:
    'sammalöneregeln gäller bara lön bestämd per vecka eller månad, och en timavlönad har ingen månadslön att räkna ' +
    'semestertillägget på (Semesterlagen 16 § andra stycket 1). Byt semesterregel till procentregeln eller ange beloppet ' +
    'på semesterraden, och beräkna om.',
  en:
    'sammalöneregeln applies only to pay set per week or month, and an hourly employee has no monthly salary to take the ' +
    'semestertillägg from (Semesterlagen 16 § second paragraph 1). Switch the vacation rule to procentregeln or put the amount ' +
    'on the vacation line, then calculate again.',
}

const HOURLY_ADVANCE: VacationPayReason = {
  sv:
    'förskottssemester betyder att den ordinarie lönen löper under ledigheten, men en timavlönad har ingen lön som löper. ' +
    'Ange beloppet för förskottsdagarna på semesterraden, och beräkna om.',
  en:
    'förskottssemester means the ordinary salary runs on through the leave, but an hourly employee has no salary that runs on. ' +
    'Put the amount for the advance days on the vacation line, then calculate again.',
}

const ALREADY_PAID_AS_COMPENSATION: VacationPayReason = {
  sv:
    'semesterlönen betalas redan ut som semesterersättning med varje lön, så ledigheten är utan lön. ' +
    'Registrera dagarna som obetalda, eller ange beloppet på semesterraden, och beräkna om.',
  en:
    'the vacation pay is already paid out as semesterersättning with every salary, so the leave itself is unpaid. ' +
    'Register the days as unpaid, or put the amount on the vacation line, then calculate again.',
}

/**
 * The rows and breakdown steps for one payslip's days-only vacation lines,
 * or the reason they cannot be priced. Pure: run-calculation supplies the
 * inputs and writes the rows.
 */
export function deriveVacationDaysPay(input: DeriveVacationDaysPayInput): DeriveVacationDaysPayResult {
  const { days } = input
  const hourly = input.salaryType === 'hourly'
  const daysOff = paidLikeDaysOff(days)
  const paidDays = roundPaidDays(daysOff * (input.paidDaysPerDayOff > 0 ? input.paidDaysPerDayOff : 1))
  const monthly = hourly ? 0 : roundOre(input.monthlySalary || 0)
  const divisor = input.dailyDivisor > 0 ? input.dailyDivisor : 21
  const dailyRate = roundOre(monthly / divisor)
  const rows: DerivedVacationPayRow[] = []
  const steps: CalculationStep[] = []

  const push = (row: Omit<DerivedVacationPayRow, 'sort_order'>, step: CalculationStep) => {
    if (row.amount === 0) return
    rows.push({ ...row, sort_order: SORT_ORDER[row.kind] })
    steps.push(step)
  }

  const deductUnpaid = () => {
    if (hourly || !(days.unpaid > 0)) return
    const amount = -roundOre(dailyRate * days.unpaid)
    push(
      {
        kind: 'obetald_semester',
        description: `Obetald semester ${daysText(days.unpaid)} × ${kr(dailyRate)}`,
        amount,
        // Not semesterlönegrundande (none of 17-17 b §§): pay never earned
        // lowers the procentregeln base, like tjänstledighet.
        is_vacation_basis: true,
        is_gross_deduction: true,
      },
      {
        label: 'Obetald semester (Semesterlagen 8 §)',
        formula: 'obetalda semesterdagar × dagslön (månadslön / dagdivisor)',
        input: { days_off: days.unpaid, monthly_salary: monthly, daily_divisor: divisor, daily_rate: dailyRate },
        output: amount,
      },
    )
  }

  const advanceStep = () => {
    if (!(days.advance > 0)) return
    steps.push({
      label: 'Förskottssemester',
      formula: 'månadslönen löper under ledigheten; inget semestertillägg eller semesterlön räknas fram för förskottsdagar',
      input: { days_off: days.advance },
      output: null,
    })
  }

  switch (input.vacationRule) {
    case 'sammaloneregeln': {
      if (hourly && (daysOff > 0 || days.advance > 0)) return { ok: false, reason: SAMMALONE_HOURLY }
      if (daysOff > 0) {
        const rate = Number(input.semestertillaggRate) || 0
        const perDay = roundOre(monthly * rate)
        const amount = roundOre(perDay * paidDays)
        const shortWeek = paidDays !== daysOff
        push(
          {
            kind: 'semestertillagg',
            // On a short week the paid days differ from the days off
            // (12 a §): both are named so the count can be checked.
            description:
              `Semestertillägg ${shortWeek ? `${dayCount(paidDays)} betalda dagar (${dayCount(daysOff)} lediga)` : daysText(paidDays)}` +
              ` × ${kr(perDay)} (${pct(rate)} av ${kr(monthly)})`,
            amount,
            is_vacation_basis: false,
            is_gross_deduction: false,
          },
          {
            label: `Semestertillägg (Semesterlagen 16 a §, ${pct(rate)})`,
            formula: 'betalda semesterdagar × månadslön × semestertillägg; månadslönen löper under semestern',
            input: {
              days_off: daysOff,
              paid_days_per_day_off: input.paidDaysPerDayOff,
              paid_days: paidDays,
              monthly_salary: monthly,
              semestertillagg_rate: rate,
              per_day: perDay,
              ...(days.extraPaid > 0 ? { extra_paid_days_off: days.extraPaid } : {}),
              ...(days.saved > 0 ? { saved_days_off: days.saved } : {}),
            },
            output: amount,
          },
        )
      }
      advanceStep()
      deductUnpaid()
      break
    }
    case 'procentregeln': {
      if (hourly && days.advance > 0) return { ok: false, reason: HOURLY_ADVANCE }
      if (daysOff > 0) {
        const value = input.procentregelnDayValue
        if (!value) throw new Error('procentregelnDayValue is required for procentregeln paid days')
        if (!value.known) return { ok: false, reason: value.reason }
        if (!hourly) {
          const deduction = -roundOre(dailyRate * daysOff)
          push(
            {
              kind: 'semesterloneavdrag',
              description: `Semesterlöneavdrag ${daysText(daysOff)} × ${kr(dailyRate)}`,
              amount: deduction,
              // The salary the leave replaces: the base keeps only worked pay.
              is_vacation_basis: true,
              is_gross_deduction: true,
            },
            {
              label: 'Semesterlöneavdrag (procentregeln)',
              formula: 'semesterdagar × dagslön (månadslön / dagdivisor); semesterlönen ersätter lönen för dagarna',
              input: { days_off: daysOff, monthly_salary: monthly, daily_divisor: divisor, daily_rate: dailyRate },
              output: deduction,
            },
          )
        }
        const amount = roundOre(value.perDay * paidDays)
        push(
          {
            kind: 'semesterlon',
            description:
              `Semesterlön ${paidDays !== daysOff ? `${dayCount(paidDays)} betalda dagar (${dayCount(daysOff)} lediga)` : daysText(paidDays)} × ${kr(value.perDay)} ` +
              `(${pct(value.rate)} av ${kr(value.base)} / ${daysText(value.earnedDays)}, ${value.yearLabel})`,
            amount,
            // Semesterlön is not semesterlönegrundande (16 b § andra stycket 1).
            is_vacation_basis: false,
            is_gross_deduction: false,
          },
          {
            label: `Semesterlön (Semesterlagen 16 b §, ${pct(value.rate)})`,
            formula: 'betalda semesterdagar × semesterlöneprocent × semesterlönegrundande lön / intjänade betalda dagar',
            input: {
              paid_days: paidDays,
              paid_days_per_day_off: input.paidDaysPerDayOff,
              rate: value.rate,
              vacation_basis: value.base,
              earned_days: value.earnedDays,
              earning_year: value.yearLabel,
              payslips: value.payslips,
              per_day: value.perDay,
              ...(days.extraPaid > 0 ? { extra_paid_days_off: days.extraPaid } : {}),
              ...(days.saved > 0 ? { saved_days_off: days.saved } : {}),
            },
            output: amount,
          },
        )
      }
      advanceStep()
      deductUnpaid()
      break
    }
    case 'semesterersattning': {
      if (daysOff > 0 || days.advance > 0) return { ok: false, reason: ALREADY_PAID_AS_COMPENSATION }
      deductUnpaid()
      break
    }
    default:
      // 'none': vacation is part of the salary, which runs on. Only a day
      // without pay changes the payslip.
      deductUnpaid()
  }

  return { ok: true, rows, steps }
}
