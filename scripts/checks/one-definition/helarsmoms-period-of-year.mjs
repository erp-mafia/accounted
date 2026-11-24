export default {
  rule: 'helarsmoms-period-of-year',
  says: 'Helårsmoms period `year` is the recorded räkenskapsår that ends in that year, resolved by resolvePeriodDates; when the company has räkenskapsår and none ends in it there is no such period and it is refused, never computed as January to December.',
  home: 'src/lib/reports/vat-declaration.ts: resolvePeriodDates (the pick among years ending in `year`: src/lib/reports/period-dates.ts: fiscalPeriodForVatYear)',
  why: 'An extended first räkenskapsår starting mid-year got a helårsmoms period for the calendar year it started in, which the report, the close check and the momsredovisning computed, filed and settled, and the next year counted again.',
  match: [
    // The räkenskapsår ending in a calendar year, read by hand:
    // .gte('period_end', `${year}-01-01`)
    /\.gte\(\s*'period_end',\s*`\$\{[^}]+\}-01-01`/,
    // A yearly momsperiod computed as the calendar year.
    /calculatePeriodDates\(\s*'yearly'/,
  ],
  sanctioned: ['lib/reports/vat-declaration.ts', 'lib/reports/period-dates.ts'],
  allowed: {
    'app/api/bolaget/owner-tax/route.ts':
      'The balansdag of an inkomstår for the K10 and owner loan figures: an income tax year, not a momsperiod.',
  },
}
