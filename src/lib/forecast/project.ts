/**
 * The projection: an opening balance and the flows, added up per day and per
 * ISO week as opening + in - out = closing, with the lowest point flagged.
 * Pure: the adapters (./adapters) read the sources, this only sums.
 */
import { addDaysIso, daysBetweenIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { isoWeekLabel, startOfIsoWeek } from './calendar'
import type { CashFlow, ForecastDay, ForecastWeek, ForecastWindow } from './types'

/** How many days the daily view shows. */
export const FORECAST_DAYS = 30

export interface Projection {
  days: ForecastDay[]
  weeks: ForecastWeek[]
  lowest: { date: string; closing: number; iso_week: string }
  closing: number
  /** The flows inside the window, by date (ties keep their input order). */
  flows: CashFlow[]
}

export function projectCashForecast(input: {
  window: ForecastWindow
  weeks: number
  opening: number
  flows: readonly CashFlow[]
}): Projection {
  const { window, weeks } = input
  const flows = input.flows
    .filter((f) => f.date >= window.today && f.date <= window.end && f.amount > 0)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.date === b.f.date ? a.i - b.i : a.f.date < b.f.date ? -1 : 1))
    .map(({ f }) => f)

  const inByDay = new Map<string, number>()
  const outByDay = new Map<string, number>()
  for (const f of flows) {
    const bucket = f.direction === 'in' ? inByDay : outByDay
    bucket.set(f.date, roundOre((bucket.get(f.date) ?? 0) + f.amount))
  }

  // Every day from today through the last day of the last week.
  const all: ForecastDay[] = []
  let balance = roundOre(input.opening)
  const span = daysBetweenIso(window.today, window.end)
  for (let i = 0; i <= span; i++) {
    const date = addDaysIso(window.today, i)
    const inflow = inByDay.get(date) ?? 0
    const outflow = outByDay.get(date) ?? 0
    const opening = balance
    balance = roundOre(opening + inflow - outflow)
    all.push({ date, opening, inflow, outflow, closing: balance, lowest: false })
  }

  let lowestIndex = 0
  for (let i = 1; i < all.length; i++) if (all[i].closing < all[lowestIndex].closing) lowestIndex = i
  all[lowestIndex].lowest = true
  const lowestDay = all[lowestIndex]
  const lowestWeek = isoWeekLabel(lowestDay.date)

  const firstMonday = startOfIsoWeek(window.today)
  const weekRows: ForecastWeek[] = []
  for (let w = 0; w < weeks; w++) {
    const start = addDaysIso(firstMonday, 7 * w)
    const end = addDaysIso(start, 6)
    const inWeek = all.filter((d) => d.date >= start && d.date <= end)
    const iso = isoWeekLabel(start)
    weekRows.push({
      iso_week: iso,
      start,
      end,
      opening: inWeek[0].opening,
      inflow: roundOre(inWeek.reduce((sum, d) => sum + d.inflow, 0)),
      outflow: roundOre(inWeek.reduce((sum, d) => sum + d.outflow, 0)),
      closing: inWeek[inWeek.length - 1].closing,
      min_closing: Math.min(...inWeek.map((d) => d.closing)),
      lowest: iso === lowestWeek,
    })
  }

  return {
    days: all.slice(0, FORECAST_DAYS),
    weeks: weekRows,
    lowest: { date: lowestDay.date, closing: lowestDay.closing, iso_week: lowestWeek },
    closing: all[all.length - 1].closing,
    flows,
  }
}
