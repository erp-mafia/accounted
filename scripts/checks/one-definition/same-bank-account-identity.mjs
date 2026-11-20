export default {
  rule: 'same-bank-account-identity',
  says: 'Two cash_accounts rows are the same bank account when their normalized IBAN and currency match; a null side stays compatible and a row without an IBAN is only itself.',
  home: 'src/lib/cash-accounts/ledger-slots.ts: physicalAccountKey, sameCashAccount, through lib/cash-accounts/service.ts (SQL: public.normalize_iban)',
  why: 'The ingest guard read one account from the IBAN while the booking guard compared row ids, so a reconnect twin hid a booked copy of the same movement.',
  match: [
    // An IBAN and a currency compared by hand.
    /normalizeIban\([^)]*\)\s*===?\s*[^&]*&&[^&]*currency/,
    // A key spelled by hand.
    /`\$\{[^}]*iban\}[|:]\$\{/i,
    // Two cash accounts told apart by row id alone.
    /cash_account_id\s*!==\s*target\w*/,
    // Another body of the normalization: it lives in ledger-slots.ts.
    /function normalizeIban\(/,
  ],
  sanctioned: ['lib/cash-accounts/ledger-slots.ts'],
  allowed: {
    'lib/payments/orders/debit-match.ts': 'a counterparty IBAN on a bank row, read off free text: its length floor is the rule that tells an IBAN from a number.',
  },
}
