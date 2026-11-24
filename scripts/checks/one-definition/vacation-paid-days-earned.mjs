export default {
  rule: 'vacation-paid-days-earned',
  says: 'The paid semesterdagar of a semesterår are the days its intjänandeår earns under Semesterlagen 7 §, employed days over the year\'s days times the year\'s days rounded up, on the statutory and the calendar basis alike.',
  home: 'src/lib/salary/vacation-ledger.ts: computeEntitledDays',
  why: 'The ledger gave a hire during a calendar intjänandeår the full year\'s days while the year close pro-rated its own copy, so the semesterlöneskuld valued days nobody had earned.',
  match: [/Math\.ceil\((?:[^()]|\([^()]*\))*(vacation_?[dD]ays_?[pP]er_?[yY]ear|[vV]acationDaysPerYear)/],
  sanctioned: ['lib/salary/vacation-ledger.ts'],
  scan: ['lib/', 'app/', 'extensions/'],
}
