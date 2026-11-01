export default {
  rule: 'bank-file-import-effects',
  says: 'Importing a bank file has the same effects through every door: rows bind to the account the file names, a period a SIE import booked is matched, transaction.synced fires, and an all-failed import reads failed.',
  home: 'src/lib/import/bank-file/import-file.ts: importBankFile',
  why: 'The dashboard and v1 each held the sequence: v1 skipped the account, the SIE overlap, the sweep and the event, and read completed when every row had failed.',
  match: [/\btoRawTransaction\(/],
  sanctioned: ['lib/import/bank-file/import-file.ts', 'lib/import/bank-file/parser.ts'],
}
