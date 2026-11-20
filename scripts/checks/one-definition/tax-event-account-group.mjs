export default {
  rule: 'tax-event-account-group',
  says: 'Debiterad preliminärskatt on 2510 and on 2518 is the same skattekonto event: a duplicate guard looking for it on one account also reads the other.',
  home: 'src/lib/transactions/skattekonto-tax-accounts.ts: sameTaxEventAccounts',
  why: 'The seed rule moved F-skatt from 2510 to 2518 Betald F-skatt (20261120150000); a guard that matched the account exactly no longer found a bank line booked to 2510 before the move, and the tax was booked twice.',
  match: [
    // A hand-written pairing of the two accounts: ['2510', '2518'] or ['2518', '2510'].
    /\[\s*'25(?:10|18)'\s*,\s*'25(?:10|18)'\s*\]/,
  ],
  sanctioned: ['lib/transactions/skattekonto-tax-accounts.ts'],
}
