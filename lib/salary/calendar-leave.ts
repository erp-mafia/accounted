import type { AbsenceDay } from './derive-absence-line-items'
import { roundOre } from '@/lib/money'

const dayMs = 86_400_000
const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dateAt = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const isWorkday = (ms: number) => new Date(ms).getUTCDay() % 6 !== 0

/** Five-day-week agreement: short leave uses working days; episodes longer
 * than five working days use calendar days. Context must come from actual
 * dated absences, never invented dates at the edges of a pay period. */
export function calendarLeaveDeduction(input: {
  monthlySalary: number; hoursPerDay: number; dailyDivisor: number
  periodStart: string; periodEnd: string; days: AbsenceDay[]
  /** Sickness after day 14 always uses the long-absence calendar rate. */
  calendarFromStart?: boolean
}): number {
  const { monthlySalary, hoursPerDay, dailyDivisor, periodStart, periodEnd } = input
  if (hoursPerDay <= 0 || dailyDivisor <= 0 || periodStart > periodEnd) throw new Error('Ogiltig period eller arbetsschema för kalenderdagsavdrag')
  const rows = [...input.days].filter(d => d.hours > 0).sort((a, b) => a.absence_date.localeCompare(b.absence_date))
  if (new Set(rows.map(d => d.absence_date)).size !== rows.length || rows.some(d => d.hours > hoursPerDay)) {
    throw new Error('Frånvaroperioden innehåller dubbletter eller timmar utöver arbetsschemat')
  }
  const fractions = new Map(rows.map(d => [d.absence_date, d.hours / hoursPerDay]))
  // A full month away deducts exactly the monthly salary, not 31/365 of annual pay.
  const scheduled: number[] = []
  for (let day = timestamp(periodStart); day <= timestamp(periodEnd); day += dayMs) {
    if (isWorkday(day)) scheduled.push(fractions.get(dateAt(day)) ?? 0)
  }
  const fullCalendarMonth = periodStart.endsWith('-01') &&
    dateAt(timestamp(periodEnd) + dayMs).endsWith('-01') && periodStart.slice(0, 7) === periodEnd.slice(0, 7)
  if (fullCalendarMonth && scheduled.length && scheduled[0] > 0 && scheduled.every(f => Math.abs(f - scheduled[0]) < 1e-8)) {
    return roundOre(monthlySalary * scheduled[0])
  }
  const episodes: AbsenceDay[][] = []
  for (const row of rows) {
    const episode = episodes.at(-1)
    const last = episode?.at(-1)
    let continuous = !!last && last.hours === row.hours
    if (last) {
      for (let day = timestamp(last.absence_date) + dayMs; day < timestamp(row.absence_date); day += dayMs) {
        if (isWorkday(day)) continuous = false
      }
    }
    if (continuous) episode!.push(row)
    else episodes.push([row])
  }
  let deduction = 0
  for (const episode of episodes) {
    const inPeriod = episode.filter(d => d.absence_date >= periodStart && d.absence_date <= periodEnd)
    if (!inPeriod.length) continue
    if (!input.calendarFromStart && episode.filter(d => isWorkday(timestamp(d.absence_date))).length <= 5) {
      deduction += roundOre(roundOre(monthlySalary / dailyDivisor) * inPeriod.reduce((sum, d) => sum + d.hours / hoursPerDay, 0))
    } else {
      const start = Math.max(timestamp(episode[0].absence_date), timestamp(periodStart))
      const end = Math.min(timestamp(episode.at(-1)!.absence_date), timestamp(periodEnd))
      const calendarDays = Math.round((end - start) / dayMs) + 1
      deduction += roundOre(roundOre(monthlySalary * 12 / 365) * calendarDays * episode[0].hours / hoursPerDay)
    }
  }
  return roundOre(deduction)
}
