export default {
  rule: 'mapping-rule-account',
  says: "A mapping rule's account is the leg that is not the bank's: its debit, or its credit when the debit is a 19xx ledger and the credit is not (a rule learned on money in), whichever way the row moves.",
  home: 'src/lib/bookkeeping/bank-leg.ts: mappingRuleAccount',
  why: "The row suggestions and the agent briefing read a rule's debit as its account. A rule learned on money in holds the bank as its debit, so its proposals were looked up from 1930 and an incoming payout was offered as a loan repayment.",
  match: [
    // A mapping rule's debit leg read as the rule's account.
    /\b(?:rule|r)\.debit_account\b/,
  ],
  sanctioned: ['lib/bookkeeping/bank-leg.ts'],
  scan: ['lib/transactions/', 'lib/agent-context/'],
}
