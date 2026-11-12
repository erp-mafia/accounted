export default {
  rule: 'account-balance-from-opening-balance',
  says: 'What stands on an account on a day is its latest ingående balans plus what is booked after it: accountBalanceThrough, or the trial balance in a report. No reader adds up every posting.',
  home: 'src/lib/bookkeeping/account-balance.ts: accountBalanceThrough',
  why: 'A sum over all history counts a year once more for each ingående balans: the onboarding summary read a skattekonto of 6 000 kr as 13 000 after two imported years, and the owner loan register doubled a loan at the first year-end.',
  match: [
    // sumAccountBalance(...): the raw sum, which knows no ingående balans.
    /\bsumAccountBalance\(/,
    // const LEDGER_BALANCE_STATUSES = [...]: a second copy of the entries a balance sums.
    /\bLEDGER_BALANCE_STATUSES\s*=\s*\[/,
    // .in('status', [...LEDGER_BALANCE_STATUSES]): a balance summed by hand.
    /\.in\(\s*'(?:journal_entries\.)?status'\s*,\s*\[\s*\.\.\.LEDGER_BALANCE_STATUSES\s*\]\s*\)/,
  ],
  sanctioned: ['lib/bookkeeping/ledger-balance.ts', 'lib/bookkeeping/account-balance.ts'],
  allowed: {
    'extensions/general/stripe/lib/transaction-sync.ts': 'Asks whether anything was ever booked on the Stripe account before the first sync day: a zero test over history, not a balance anyone reads.',
    'lib/reconciliation/bank-reconciliation.ts': 'Sums from findOpeningBalanceFloor up to the day the bank history starts: the floored opening side, with its own upper bound.',
    'lib/reconciliation/skattekonto-reconciliation.ts': 'Reads the floor once, sums two windows from it and lists the lines behind them.',
  },
}
