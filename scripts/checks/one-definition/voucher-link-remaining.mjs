export default {
  rule: 'voucher-link-remaining',
  says: 'What an invoice still owes when a verifikat is linked to it is the stored remaining_amount, a stored 0 included, for the candidate list, the validator and the RPC.',
  home: 'src/lib/invoices/voucher-matching-shared.ts: storedRemaining',
  why: 'The customer copy fell through a stored 0 to total minus paid_amount, so a paid ROT invoice owed Skatteverket\'s share and the validator passed what the RPC refused.',
  match: [/\bfunction computeRemaining\b/],
}
