export default {
  rule: 'bank-row-open-read',
  says: 'A bank row is open work when it is not ignored, not private and anchored to no live verifikat.',
  home: 'public.bank_row_anchors, public.unbooked_bank_rows and public.open_bank_rows; src/lib/transactions/unbooked.ts',
  why: 'Each list asked its own question (the pointer, any pointer, the pointer and the payments), so a row booked through a link read open, a stale pointer read booked, and a correction brought it back four times.',
  match: [
    // The triage written by hand, on a query or in memory.
    /is_business\.is\.null,is_business\.eq\.true/,
    /\.not\('is_business', 'is', false\)/,
    /!\w+\.journal_entry_id && !\w+\.is_ignored/,
    /!\w+\.is_ignored && !\w+\.journal_entry_id/,
    // The answer read per row where a list can read the view.
    /\.eq\('is_booked', false\)/,
    // The anchors read by hand.
    /isTransactionBooked\(/,
    /fetchAnchoredTransactionIds\(/,
    /fetchJunctionLinkedTxIds\(/,
  ],
  sanctioned: ['lib/transactions/unbooked.ts'],
  allowed: {
    'app/(dashboard)/transactions/page.tsx': 'list rows already read through withLivePointer, and skattekonto rows, which keep their own pointer.',
    'extensions/general/mcp-server/server.ts': 'skattekonto rows, which keep their own pointer.',
    'lib/reconciliation/skattekonto-reconciliation.ts': 'skattekonto rows, which keep their own pointer.',
    'lib/documents/bank-match/refresh.ts': 'rows that have just arrived: no verifikat can book them yet, and the proposal is read again before it is shown.',
    'lib/inkorg/expectations-read.ts': 'purchase history, booked or not: only the private rows leave it.',
  },
}
