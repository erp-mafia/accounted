export default {
  rule: 'declared-first-fiscal-year',
  says: 'A fiscal period is the company\'s declared first räkenskapsår, with no year before it, when it carries the name company creation gives one: isDeclaredFirstFiscalYearName.',
  home: 'src/lib/company/compute-fiscal-period.ts: isDeclaredFirstFiscalYearName, read for the schedule by src/lib/tax/deadline-config.ts: fiscalYearForDeadlines',
  why: 'The deadline schedule did not read the first-year answer, assumed a twelve-month year before a first year starting on the 1st, and dated an inkomstdeklaration for a year that never existed.',
  match: [
    // The first-year name recognised by hand: a regex or a prefix test.
    /\/\^?Första räkenskapsåret \\d/,
    /startsWith\(\s*['"`]Första räkenskapsåret/,
    // fiscal_periods rows mapped to the schedule's years by hand, which drops
    // the declaration: fiscalYearForDeadlines reads it.
    /fiscal_years:.*\.map\(\s*\(?\w+\)?\s*=>\s*\(\{\s*(?:start:|$)/,
  ],
  sanctioned: ['lib/company/compute-fiscal-period.ts', 'lib/tax/deadline-config.ts'],
}
