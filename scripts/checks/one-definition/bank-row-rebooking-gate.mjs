export default {
  rule: 'bank-row-rebooking-gate',
  says: 'A door that books a new verifikat on a bank row asks one gate: a row a posted verifikat books, by pointer or bank_line link, or an ignored row, is refused, and nothing reverses what the pointer names unasked.',
  home: 'src/lib/transactions/is-booked.ts: decideBankRowRebooking',
  why: 'Each door read the row its own way: the pointer only, any pointer, or the links but not the status, so a row booked through a voucher link got a second verifikat and an approval reversed an independent one.',
  match: [
    // Reads the pointer's liveness by hand instead of asking the gate.
    /hasLiveJournalEntryLink\(/,
    // Reverses whatever the row's pointer names.
    /entryId:\s*(transaction|tx)\.journal_entry_id/,
  ],
  sanctioned: ['lib/transactions/bank-link.ts'],
  allowed: {
    'app/api/transactions/[id]/uncategorize/route.ts': 'the explicit undo the refusal names: the caller asked for this storno.',
    'app/api/v1/companies/[companyId]/transactions/[id]/uncategorize/route.ts': 'the explicit undo the refusal names: the caller asked for this storno.',
    'lib/transactions/ignore.ts': 'ignoring a row releases its own auto-booking, a different rule with its own gate.',
    'lib/reconciliation/bank-reconciliation.ts': 'a link door, no booking: linkTransactionToVouchers reads every anchor itself and refuses more than the gate does.',
  },
}
