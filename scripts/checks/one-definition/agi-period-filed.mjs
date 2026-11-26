export default {
  rule: 'agi-period-filed',
  says: "An AGI redovisningsperiod's first declaration is filed when Skatteverket's kvittens for it is on record: a receipt status on the period's declaration, an agi_kvittenser row, or the agi_submitted_at stamp of a run paid out that month.",
  home: 'src/lib/deadlines/agi-period-filed.ts: agiPeriodFiled',
  why: "A correction of a filed month sent that month's frånvarouppgifter again, which Skatteverket refuses at upload (Bilaga Kontroller 1.1.18.1, ba_824), because the generator never asked whether the month was filed.",
  match: [/\.from\(\s*['"]agi_kvittenser['"]\s*\)/],
  sanctioned: ['lib/deadlines/agi-period-filed.ts'],
  allowed: {
    'extensions/general/skatteverket/lib/agi-kvittens-history.ts': 'records every kvittens Skatteverket returns and lists them for the run view; it decides no filing.',
    'lib/tax/deadline-generator.ts': "reads the kvittens and receipt status for whole years at once, so a filed period's deadline row is created completed (#201).",
  },
}
