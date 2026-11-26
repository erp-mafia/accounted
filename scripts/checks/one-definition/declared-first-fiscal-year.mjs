export default {
  rule: 'declared-first-fiscal-year',
  says: 'A fiscal period is the company\'s declared first räkenskapsår, with no year before it, when it carries the name company creation gives one: isDeclaredFirstFiscalYearName.',
  home: 'src/lib/company/compute-fiscal-period.ts: isDeclaredFirstFiscalYearName',
  why: 'The deadline schedule did not read the first-year answer, assumed a twelve-month year before a first year starting on the 1st, and dated an inkomstdeklaration for a year that never existed.',
  match: [
    // The first-year name recognised by hand: a regex or a prefix test.
    /\/\^?Första räkenskapsåret \\d/,
    /startsWith\(\s*['"`]Första räkenskapsåret/,
  ],
  sanctioned: ['lib/company/compute-fiscal-period.ts'],
}
