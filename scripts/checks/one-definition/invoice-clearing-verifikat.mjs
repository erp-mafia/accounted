export default {
  rule: 'invoice-clearing-verifikat',
  says: 'Whether a verifikat clears a receivable or a payable, and so settles an invoice instead of showing how a counterparty is booked, is answered by one function.',
  home: 'src/lib/bookkeeping/invoice-clearing.ts: clearsAnInvoice',
  why: 'The bank-link learner held the account groups privately, so a second reader of a counterparty habit would have kept its own list and proposed a clearing with no invoice behind it.',
  match: [
    // The receivables and payables groups, or the account test, written again.
    /\bCLEARING_GROUPS\b/,
    /function isClearingAccount\b/,
  ],
  sanctioned: ['lib/bookkeeping/invoice-clearing.ts'],
}
