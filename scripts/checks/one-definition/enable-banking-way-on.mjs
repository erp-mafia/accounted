export default {
  rule: 'enable-banking-way-on',
  says: 'An Enable Banking connection the old provider no longer carries goes to the switch where the campaign applies to the company and Open Payments reaches the bank, and to the bank file import otherwise.',
  home: 'src/lib/bank-feed/bank-coverage.ts: enableBankingWayOn',
  why: 'The bank page decided switch or import for the sunset alone, so while the switch campaign closed renewals its rows and the transactions page still offered a renewal the server refused.',
  match: [/bankCoveredByOpenPayments\([^)]*\)\s*\?\s*['"`](switch|import)['"`]/],
  sanctioned: ['lib/bank-feed/bank-coverage.ts'],
}
