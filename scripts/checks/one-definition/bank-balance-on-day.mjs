export default {
  rule: 'bank-balance-on-day',
  says: "The bank's balance at the end of a day is the balance it reported for that very day, else the balance after its last row through the day, found by the chain of the day's rows (a day that nets to zero ends where the day before it did) and claimed only once the history reaches the day.",
  home: 'src/lib/reconciliation/bank-balance-check.ts: checkBankBalance (with `on`), dayEndBalance',
  why: "The rows of a day carry no order, so taking the newest row's balance_after picks any row of the day, and a feed that stopped before the day reports a stale balance as the day's.",
  match: [
    // The balance before a row, worked out by hand from its balance_after.
    /\bbalance_after\)?\s*-\s*(?:Number\()?\w*\.?amount\b/,
    // The newest row's balance_after read as the day's balance.
    /\bbalance_after\b.*\.order\(\s*'date'/,
  ],
  sanctioned: ['lib/reconciliation/bank-balance-check.ts'],
}
