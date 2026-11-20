export default {
  rule: 'avgifter-report-vs-declared',
  says: 'The avgifter a report states per category are the ones the AGI declares: same category, cap split, overrides and whole-krona computation.',
  home: 'src/lib/salary/declared-avgifter.ts: declaredAvgifterForRun',
  why: 'The report read the rate alone and summed öre, so a youth payslip over the cap stayed one row at 20,81 % and an override to 0 kept its 9 426 kr, next to an AGI that said otherwise.',
  match: [/(?:\b|_)rate\s*<=\s*0\.(1022|2082)\b/],
  sanctioned: ['lib/salary/declared-avgifter.ts'],
}
