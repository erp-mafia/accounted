export default {
  rule: 'cash-account-one-currency',
  says: 'A ledger account holds one cash account and so one currency: a row in another currency than the cash account on its ledger is refused with CASH_ACCOUNT_CURRENCY_MISMATCH, before anything is stored.',
  home: 'src/lib/cash-accounts/service.ts: cashAccountCurrencyMismatch (asked without writing: findCashAccountCurrencyMismatch)',
  why: 'ensureManualCashAccount threw the refusal as a plain error, so the create_transactions approval answered it with a 500 and closed the proposal, and staging never asked it.',
  match: [
    // The refusal built by hand: its message or its code.
    /Cash account \$\{[^}]*\} is denominated in/,
    /[cC]ode: 'CASH_ACCOUNT_CURRENCY_MISMATCH'/,
  ],
  sanctioned: ['lib/cash-accounts/service.ts'],
}
