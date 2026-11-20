export default {
  rule: 'date-in-filed-vat-period',
  says: 'Whether a date lies in a momsperiod whose declaration is filed is asked of filedVatPeriodsOfDates: a door that books, imports or warns on a date reads the filing record through it, never with its own range comparison over listVatFilings.',
  home: 'src/lib/vat/filed-period-for-date.ts: filedVatPeriodsOfDates',
  why: 'Four doors compared a date with the filed ranges by hand (the SIE append, the momsredovisning mark, the staged voucher preview, the kontantmetod cut-off) while the voucher form, the bank row and the invoice said nothing about a filed period at all.',
  match: [
    // listVatFilings(supabase, companyId): a read of the whole filing record,
    // which a door asking about a date then compares by hand.
    /\blistVatFilings\(/,
  ],
  sanctioned: ['lib/vat/filing-record-store.ts', 'lib/vat/filed-period-for-date.ts'],
  allowed: {
    'lib/unexplained/checks/vat-settlement.ts':
      'Lists the declared periods to check that each one is settled: a question about periods, not about a date.',
    'lib/vat/filed-period-changes.ts':
      'Reads every filing to say what changed in each after it was filed: the after-the-fact record, not a booking date.',
    'lib/vat/filed-periods-reopened.ts':
      'Which filed periods a move of the lock date reopens: a range between two lock dates, not a booking date.',
  },
}
