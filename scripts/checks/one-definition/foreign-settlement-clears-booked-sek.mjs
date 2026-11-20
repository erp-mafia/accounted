export default {
  rule: 'foreign-settlement-clears-booked-sek',
  says: 'A settlement of a foreign document clears what the ledger carries for it, so a paid invoice leaves no öre on 1510 or 2440; the remainder at the rate is the fallback when the ledger cannot say.',
  home: 'src/lib/bookkeeping/ledger-carried-sek.ts: carriedSek, clearedSek (public.document_carried_sek)',
  why: 'A registration books the sum of its per-line SEK, not the total at the rate, so each door that cleared remainder x rate stranded öre on paid invoices; the fix for it had reached the manual supplier doors only.',
  match: [
    // The SEK of the whole remainder written at the rate.
    /\bsekOfForeign\(\s*(?:\w+\.)?(?:remaining|outstanding)\w*\s*,/,
  ],
  sanctioned: ['lib/bookkeeping/ledger-carried-sek.ts'],
  allowed: {
    'components/transactions/MatchAllocationDialog.tsx': 'the amount a person starts from in the dialog, no booking: the dry run shows what clears.',
    'lib/invoices/voucher-matching-shared.ts': 'the twin of the link RPCs gate, which reads the rate until they are restated: a limit on a voucher, nothing clears here.',
  },
}
