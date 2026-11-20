export default {
  rule: 'personnummer-century',
  says: 'A 10-digit personnummer has one century wherever it is expanded to 12 digits: the most recent birth date not after today, one century back with a plus.',
  home: 'src/lib/invariants/personal-number-shape.ts: expandPersonnummerTo12',
  why: 'Five copies compared two-digit years or guessed from the income year, so one firm could file its NE under one century and its moms under another.',
  match: [/getFullYear\(\)\s*%\s*100/],
  sanctioned: ['lib/invariants/personal-number-shape.ts'],
}
