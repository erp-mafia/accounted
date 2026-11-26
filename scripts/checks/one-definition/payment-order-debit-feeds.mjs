export default {
  rule: 'payment-order-debit-feeds',
  says: "Which bank feeds a debit must come from to move a bank payment order without a person (settle it, link it, execute it) has one answer: DEBIT_FEEDS, the rows the bank's own API delivered.",
  home: 'src/lib/payments/orders/debit-match.ts: DEBIT_FEEDS, isBankFeedDebit',
  why: "The status sync's sweep held the list alone, so the ingest's order link, written with the service role, took any source, a bank file a person uploaded included.",
  match: [
    // .in('import_source', ['open_payments', 'enable_banking']): the feeds listed again in a read.
    /import_source['"]\s*,\s*\[\s*['"](?:open_payments|enable_banking)['"]\s*,\s*['"](?:open_payments|enable_banking)['"]\s*\]/,
    // = ['open_payments', 'enable_banking']: the feeds listed again as a constant.
    /=\s*\[\s*['"](?:open_payments|enable_banking)['"]\s*,\s*['"](?:open_payments|enable_banking)['"]\s*\]/,
  ],
  sanctioned: ['lib/payments/orders/debit-match.ts'],
  scan: ['lib/payments/'],
}
