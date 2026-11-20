export default {
  rule: 'previous-fiscal-year-is-adjacent',
  says: 'The year before a räkenskapsår ends the day before it starts; a year across a gap is never it.',
  home: 'src/lib/core/bookkeeping/period-service.ts: resolvePreviousFiscalPeriod',
  why: 'Two doors took the nearest earlier year, so the loss-carryforward proposal offered a deficit from two years back as last year\'s and the SIE review judged a file\'s IB on the wrong year.',
  match: [
    /\.lt\('period_end',\s*[\w.]*(?:period_?[sS]tart|[sS]tart(?:Date)?)\b/,
    /\.eq\('period_end',\s*(?:addDaysIso|shiftIsoDate|dayBefore)\(/,
    /\.period_end\s*===\s*(?:addDaysIso|shiftIsoDate|dayBefore)\(/,
  ],
  sanctioned: ['lib/core/bookkeeping/period-service.ts'],
  allowed: {
    'components/settings/AccountingFrameworkForm.tsx': 'Reads the years the browser already holds, where period-service cannot run; same answer as the definition.',
  },
}
