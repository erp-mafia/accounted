export default {
  rule: 'skattekonto-row-open',
  says: 'A skattekonto row is open work when Skatteverket carried it out, no verifikat holds it, it is not ignored and it is dated on or after the ingående balans on the skattekonto account; a row before that IB is carried by it.',
  home: 'src/lib/skatteverket/skattekonto-open-rows.ts: isOpenSkattekontoRow, isSkattekontoRowBeforeHistory, whereSkattekontoRowOpen',
  why: 'The reconciliation left rows before the IB out as history while Att göra, the Hem step and the Transaktioner inbox each counted every unlinked row, so a migrated company was asked to book or ignore every row its opening balance already held (crm#2010).',
  match: [
    // The before-history date test written by hand.
    /transaktionsdatum\s*<\s*(historyStart|history_start|openingDate)\b/,
    // An unbooked count over skattekonto rows read from the pointer alone.
    /\.filter\(\(\w+\) => !\w+\.journal_entry_id\)\.length/,
  ],
  sanctioned: ['lib/skatteverket/skattekonto-open-rows.ts'],
  allowed: {
    'app/(dashboard)/skattekonto/page.tsx': 'gates the read of rows a verifikat already holds (the link-all line), carried rows included: a link proposal, not a count of work.',
  },
}
