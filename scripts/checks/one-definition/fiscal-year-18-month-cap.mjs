export default {
  rule: 'fiscal-year-18-month-cap',
  says: 'A räkenskapsår is at most 18 months (BFL 3 kap.), counted one way.',
  home: 'src/lib/bookkeeping/validate-period-duration.ts: exceedsFiscalYearCap',
  why: 'Four doors counted the months four ways: a year starting on the last of a month was over the cap at one door and under it at the next.',
  match: [
    /\bmonthsBetween\([^)]*\)\s*>=?\s*18\b/,
    /\b(?!period)\w*[mM]onth(?:s|Count)\s*>=?\s*18\b/,
    /\b\w*[mM]onths\w*\([^)]*,\s*18\)/,
    /\bstart\w*\s*\+\s*18\b/,
  ],
  sanctioned: ['lib/bookkeeping/validate-period-duration.ts'],
}
