export default {
  rule: 'first-fiscal-period-definition',
  says: 'A company\'s first räkenskapsår is the one no recorded year starts before.',
  home: 'src/lib/bookkeeping/validate-period-duration.ts: isFirstFiscalPeriod',
  why: 'iXBRL read a missing comparison year as a first year, so the preflight let a year behind a gap through without the comparatives ÅRL asks for.',
  match: [
    /\.lt\('period_start',\s*[\w.]*[sS]tart\w*\b/,
    /\.some\(\(?\w+\)?\s*=>\s*\w+\.period_start\s*<(?!=)/,
    /\bisFirst(?:Fiscal)?(?:Year|Period):\s*(?:!\s*\w+\b(?!\()|\w+\s*===\s*null)/,
  ],
  sanctioned: ['lib/bookkeeping/validate-period-duration.ts'],
}
