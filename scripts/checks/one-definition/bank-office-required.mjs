export default {
  rule: 'bank-office-required',
  says: 'A bank that takes no request for itself (its own row is not offered) is named by its BIC in one list.',
  home: 'src/components/bank-feed/bank-help.ts: bankRequiresOffice',
  why: 'The office picker offered the bank itself as the default for every bank, so a bank that needs one of its offices was started without one and refused.',
  match: [/['"`]RESUSE2H/],
  sanctioned: ['components/bank-feed/bank-help.ts'],
}
