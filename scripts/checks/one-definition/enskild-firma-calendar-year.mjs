export default {
  rule: 'enskild-firma-calendar-year',
  says: 'An enskild firma\'s räkenskapsår is the calendar year: it ends 31 December and only the first year may start after 1 January.',
  home: 'src/lib/bookkeeping/validate-period-duration.ts: checkPeriodDuration (calendarYearOnly); src/lib/company/fiscal-year.ts: fiscalYearStartMonthFor',
  why: 'Re-dating a year refused what creating one or importing one wrote, so a firm could hold broken years no door could edit.',
  match: [
    /\.month\s*!==\s*12\s*\|\|\s*\w+\.day\s*!==\s*31/,
    /\.endsWith\('-?12-31'\)/,
    /fiscalYearLockedToCalendar\([^)]*\)\)?\)?\s*(?:startMonth\s*=\s*1|return\s+1)\b/,
  ],
  sanctioned: ['lib/bookkeeping/validate-period-duration.ts', 'lib/company/fiscal-year.ts'],
  allowed: {
    'lib/bokslut/ixbrl/document/layout.ts': 'Prints a year\'s label; refuses nothing.',
  },
}
