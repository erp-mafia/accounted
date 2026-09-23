import { roundOre } from '@/lib/money'
import type { AbsenceDay } from './derive-absence-line-items'

/**
 * Calendar-day deduction for long leave (policy long_leave =
 * 'calendar_after_five_workdays', see lib/salary/calculation-policy.ts).
 *
 * The tjänstemannaavtal convention Fortnox implements:
 *   - an episode of at most five working days deducts per working day at
 *     månadslön / dagdivisor (the same daily rate the default convention
 *     uses, so short leave is priced identically under both);
 *   - a longer episode deducts per CALENDAR day, intervening weekends
 *     included, at (månadslön × 12 / 365) rounded to öre first;
 *   - leave covering every scheduled day of a full calendar month deducts
 *     exactly the monthly salary (times the common extent), never 31/365 of
 *     a year's pay.
 *
 * Episodes are built from the actual dated rows. Rows outside the period
 * (prior or, depending on leave_context, following month) only decide how
 * long an episode is; the deduction covers the in-period days alone, so a
 * day is never deducted twice across two runs. Consecutive working days
 * with the same extent (hours) form one episode; an unreported working day
 * or a change of extent starts a new one.
 */
export interface CalendarLeaveInput {
  monthlySalary: number
  /** Scheduled hours per working day; a row's hours against it is its extent, capped at a full day. */
  hoursPerDay: number
  /** Daily-rate divisor for episodes of at most five working days (21 at the default schedule). */
  dailyDivisor: number
  periodStart: string
  periodEnd: string
  /** Rows of ONE absence type: in-period rows plus whatever context the caller allows. */
  days: AbsenceDay[]
  /** Sick day 15+ (Försäkringskassan period) is always priced per calendar day. */
  calendarFromStart?: boolean
}

const DAY_MS = 86_400_000
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const isWorkday = (ms: number) => new Date(ms).getUTCDay() % 6 !== 0

export function calendarLeaveDeduction(input: CalendarLeaveInput): number {
  const { monthlySalary, hoursPerDay, dailyDivisor, periodStart, periodEnd } = input
  if (!(hoursPerDay > 0) || !(dailyDivisor > 0) || periodStart > periodEnd) {
    throw new Error('Ogiltig period eller arbetsschema för kalenderdagsavdrag')
  }

  // One extent per date: several rows on the same date add up, capped at a
  // full day, and a row without hours counts as a full day (the same reading
  // derive-absence-line-items applies to every other deduction).
  const extentByDate = new Map<string, number>()
  for (const row of input.days) {
    const share = Number.isFinite(row.hours) && row.hours > 0 ? Math.min(1, row.hours / hoursPerDay) : 1
    extentByDate.set(row.absence_date, Math.min(1, (extentByDate.get(row.absence_date) ?? 0) + share))
  }
  const dates = [...extentByDate.keys()].sort()
  if (dates.length === 0) return 0

  // A full calendar month away at one extent deducts the monthly salary.
  const scheduled: number[] = []
  for (let ms = toMs(periodStart); ms <= toMs(periodEnd); ms += DAY_MS) {
    if (isWorkday(ms)) scheduled.push(extentByDate.get(toIso(ms)) ?? 0)
  }
  const fullCalendarMonth =
    periodStart.endsWith('-01') &&
    toIso(toMs(periodEnd) + DAY_MS).endsWith('-01') &&
    periodStart.slice(0, 7) === periodEnd.slice(0, 7)
  if (
    fullCalendarMonth &&
    scheduled.length > 0 &&
    scheduled[0] > 0 &&
    scheduled.every(extent => Math.abs(extent - scheduled[0]) < 1e-8)
  ) {
    return roundOre(monthlySalary * scheduled[0])
  }

  // Episodes: consecutive working days at the same extent.
  const episodes: Array<Array<{ date: string; extent: number }>> = []
  for (const date of dates) {
    const extent = extentByDate.get(date)!
    const episode = episodes[episodes.length - 1]
    const last = episode?.[episode.length - 1]
    let continuous = last !== undefined && Math.abs(last.extent - extent) < 1e-8
    if (last) {
      for (let ms = toMs(last.date) + DAY_MS; ms < toMs(date); ms += DAY_MS) {
        if (isWorkday(ms)) continuous = false
      }
    }
    if (continuous) episode.push({ date, extent })
    else episodes.push([{ date, extent }])
  }

  const dailyRate = roundOre(monthlySalary / dailyDivisor)
  const calendarRate = roundOre((monthlySalary * 12) / 365)
  let deduction = 0
  for (const episode of episodes) {
    const inPeriod = episode.filter(d => d.date >= periodStart && d.date <= periodEnd)
    if (inPeriod.length === 0) continue
    const workdaysInEpisode = episode.filter(d => isWorkday(toMs(d.date))).length
    if (!input.calendarFromStart && workdaysInEpisode <= 5) {
      deduction += roundOre(dailyRate * inPeriod.reduce((sum, d) => sum + d.extent, 0))
    } else {
      const start = Math.max(toMs(episode[0].date), toMs(periodStart))
      const end = Math.min(toMs(episode[episode.length - 1].date), toMs(periodEnd))
      const calendarDays = Math.round((end - start) / DAY_MS) + 1
      deduction += roundOre(calendarRate * calendarDays * episode[0].extent)
    }
  }
  return roundOre(deduction)
}
