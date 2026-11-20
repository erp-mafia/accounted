export default {
  rule: 'fiscal-year-boundaries-from-recorded-years',
  says: 'Once a company has recorded räkenskapsår the next year chains from them; fiscal_year_start_month only fills what nothing records.',
  home: 'src/lib/bookkeeping/suggest-fiscal-period.ts: nextFiscalYearRange; src/lib/tax/deadline-config.ts: fiscalYearEndMonthIn, fiscalYearEndMonthOn',
  why: 'The bank door minted a year from the settings month and the filing record labelled helårsmoms from it, so a company out of step got a year overlapping or a hole behind its last one, and a filing that missed its deadline row.',
  match: [
    /\bset(?:UTC)?Month\(.*\+\s*12\)/,
    /\b(?:addDays(?:Iso)?|shiftIsoDate)\(\s*addMonths(?:Iso)?\([^,]+,\s*12\)\s*,\s*-1\)/,
    /\bString\(fiscal_?[yY]ear_?[sS]tart_?[mM]onth\)/,
    /\bfiscalYearEndMonthFor\(/,
  ],
  sanctioned: ['lib/bookkeeping/suggest-fiscal-period.ts', 'lib/tax/deadline-config.ts'],
}
