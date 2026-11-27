export default {
  rule: 'income-year-to-file',
  says: 'The inkomstår whose owner filings are due is last year in January, while KU31 and KU20 for it are due by 31 January, and this year from February; Kapitalhändelser and Ägarskatt och närstående open on it.',
  home: 'src/lib/bolaget/filing-year.ts: incomeYearToFile',
  why: 'Kapitalhändelser stepped back a year in January for KU31 while Ägarskatt och närstående opened on the calendar year, so from 1 January it opened on a year without K10 underlag while the filings due were last year\'s.',
  match: [
    // A January test whose answer is last year: now.slice(5, 7) === '01' ? year - 1 : year.
    /===\s*'01'\s*\?[^:]*-\s*1\s*:/,
    /getMonth\(\)\s*===\s*0\s*\?[^:]*-\s*1\s*:/,
  ],
  sanctioned: ['lib/bolaget/filing-year.ts'],
}
