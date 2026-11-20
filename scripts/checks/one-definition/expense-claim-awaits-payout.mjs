export default {
  rule: 'expense-claim-awaits-payout',
  says: 'An expense claim waits for a payout of its own when it is registered and on no payslip line: Att göra, the bank row suggestion, the utlägg page, the claim picker, "Lägg till öppna utlägg" and the v1 and MCP lists all get that answer from one reader.',
  home: 'src/lib/salary/expense-claim-payout-state.ts: listExpenseClaimsAwaitingPayout, withExpenseClaimPayoutState',
  why: 'Att göra and the bank row suggestion read status registered alone as still owed, and only the payslip flow knew the link: a claim already on a draft salary run was listed for a second payout, and no list could say which run it was on (crm#1942).',
  match: [
    // Asking which claims a payslip line points at, by hand.
    /\.(?:in|eq)\(\s*'source_expense_claim_id'/,
  ],
  sanctioned: ['lib/salary/expense-claim-payout-state.ts'],
  allowed: {
    'lib/salary/expense-claim-lines.ts':
      'findPayslipLineForClaim: the one line of one claim, for deleting the claim (a draft run loses the line first, a run past draft refuses), not whether the claim waits for a payout.',
  },
}
