/**
 * The fiscal year rules' guards catch the shapes that were written by hand, and
 * leave the lines that only look alike.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import previous from '../one-definition/previous-fiscal-year-is-adjacent.mjs'
import boundaries from '../one-definition/fiscal-year-boundaries-from-recorded-years.mjs'
import first from '../one-definition/first-fiscal-period-definition.mjs'
import ended from '../one-definition/fiscal-year-has-ended.mjs'
import cap from '../one-definition/fiscal-year-18-month-cap.mjs'
import calendar from '../one-definition/enskild-firma-calendar-year.mjs'

const hits = (rule: Parameters<typeof findRuleLines>[1], line: string) => findRuleLines(line, rule).length > 0

describe.each([
  ['previous-fiscal-year-is-adjacent', previous, [
    ".lt('period_end', period.period_start)",
    ".lt('period_end', periodStart)",
    ".lt('period_end', start)",
    ".lt('period_end', input.startDate)",
    ".eq('period_end', addDaysIso(current.period_start, -1))",
    ".eq('period_end', dayBefore(period.period_start))",
    'periods.find((p) => p.period_end === addDaysIso(start, -1))',
  ], [".lt('period_end', decidedOn)", ".eq('period_end', period.end)", '.find((p) => p.period_end === period.end)']],
  ['fiscal-year-boundaries-from-recorded-years', boundaries, [
    'nextEnd.setUTCMonth(nextEnd.getUTCMonth() + 12)',
    "const startMonth = String(fiscalYearStartMonth).padStart(2, '0')",
    'return fiscalYearEndMonthFor(settings ?? {}) ?? 12',
    'const end = addDaysIso(addMonthsIso(start, 12), -1)',
    'return shiftIsoDate(addMonthsIso(period.start, 12), -1)',
  ], [
    'const end = addMonthsIso(start, 12)',
    "const label = String(month).padStart(2, '0')",
    'const sixYearsEnd = addDaysIso(addMonthsIso(plan.from, 72), -1)',
  ]],
  ['first-fiscal-period-definition', first, [
    ".lt('period_start', newStart)",
    'const isFirstPeriod = !sortedPeriods.some((p) => p.period_start < input.period_start)',
    'isFirstFiscalYear: previousPeriod === null,',
    'isFirstFiscalYear: !previousPeriod,',
    'isFirstPeriod: !earlierYear,',
  ], [
    'if (!periods.some((p) => p.period_start <= asOf && asOf <= p.period_end)) {',
    ".lt('period_start', asOf)",
    'isFirstPeriod: !!isFirstYear,',
    'isFirstFiscalYear: isFirstFiscalPeriod(period.period_start, starts),',
  ]],
  ['fiscal-year-has-ended', ended, [
    'if (period.period_end > today) {',
    '.filter((p) => p.period_end <= today)',
    'input.period.end >= today',
    "const nothingDue = periodEnd >= today ? 'period_not_ended' : due",
    'if (fy.end >= today) return false',
    "if (year.end > todayIsoStockholm()) {",
    ".lte('period_end', today)",
    ".gt('period_end', todayIso)",
  ], [
    '.filter((p) => p.period_start <= todayIso && p.period_end >= todayIso)',
    'if (hasEnded(period.period_end, today)) {',
    'allYears.find((fy) => fy.start <= today && today <= fy.end)',
    ".gte('period_end', today)",
    ".lt('period_end', today)",
  ]],
  ['fiscal-year-18-month-cap', cap, [
    'monthsBetween(input.period.start, input.period.end) >= 18',
    'if (months > 18) {',
    'if (monthCount > 18) {',
    'if (rarMonths >= 18) {',
    'periodEnd >= addCalendarMonths(periodStart, 18)',
    'const targetM = (startM + 18) % 12',
  ], ['if (input.periodMonths > 18) {', 'if (exceedsFiscalYearCap(start, end)) {']],
  ['enskild-firma-calendar-year', calendar, [
    'if (e.month !== 12 || e.day !== 31) {',
    "!value.first_fiscal_year.end.endsWith('-12-31')",
    "if (!end.endsWith('12-31')) {",
    'if (isEntityType(s.entity_type) && fiscalYearLockedToCalendar(s.entity_type)) startMonth = 1',
  ], ['const calendarYearOnly = fiscalYearLockedToCalendar(setup.entity_type)']],
] as const)('%s', (_name, rule, written, alike) => {
  it.each(written)('catches %s', (line) => {
    expect(hits(rule, line)).toBe(true)
  })

  it.each(alike)('leaves %s', (line) => {
    expect(hits(rule, line)).toBe(false)
  })
})
