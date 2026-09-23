/**
 * The payslip calendar's period (components/salary/SalaryCalendar.tsx).
 *
 * The calendar's `periodStart` / `periodEnd` decide five things at once: the
 * month it opens on, which days are shaded as in-period, which weekdays
 * "fill weekdays" selects, which worked hours are summed in the footer, and
 * which absence dates are counted into the live day badges. Every one of
 * those must describe the days the calculation engine READS for the run, and
 * the engine reads the run's avvikelseperiod (lib/salary/deviation-period.ts),
 * not the pay month. On a company that runs "innevarande månads lön,
 * föregående månads avvikelser", the September payslip works in August.
 *
 * Pure functions only: this file is imported by client components.
 */

import { runDeviationWindow, type DateWindow, type RunDeviationSource } from './deviation-period'

/**
 * The window the payslip calendar works in for a run: the run's
 * avvikelseperiod when it has one, otherwise the pay month. Exactly the
 * window run-calculation.ts reads absence and worked days from, so what the
 * calendar counts is what the payslip deducts.
 */
export function payslipCalendarWindow(run: RunDeviationSource): DateWindow {
  return runDeviationWindow(run)
}

/**
 * First day (ISO) of the month the calendar opens on: the month the window
 * starts in. A window that straddles two months (an explicit 20th-to-19th
 * window) opens on the earlier one, where registration starts.
 */
export function calendarOpeningMonth(window: DateWindow): string {
  return `${window.start.slice(0, 7)}-01`
}

export interface CalendarAbsenceRow {
  absence_date: string
  absence_type: string
}

export interface LiveAbsenceCounts {
  sick: number
  vab: number
  parental: number
}

/**
 * Live day badges: unique absence dates per category inside the window.
 * Parental groups parental + pregnancy + care_relative, the same way the
 * salary_run_employees snapshot column lumps them. Rows outside the window
 * are ignored: the calendar also loads the visible grid around it.
 */
export function countAbsenceDatesInWindow(
  rows: readonly CalendarAbsenceRow[],
  window: DateWindow,
): LiveAbsenceCounts {
  const sick = new Set<string>()
  const vab = new Set<string>()
  const parental = new Set<string>()
  for (const row of rows) {
    if (row.absence_date < window.start || row.absence_date > window.end) continue
    if (row.absence_type === 'sick') sick.add(row.absence_date)
    else if (row.absence_type === 'vab') vab.add(row.absence_date)
    else if (
      row.absence_type === 'parental' ||
      row.absence_type === 'pregnancy' ||
      row.absence_type === 'care_relative'
    ) {
      parental.add(row.absence_date)
    }
  }
  return { sick: sick.size, vab: vab.size, parental: parental.size }
}
