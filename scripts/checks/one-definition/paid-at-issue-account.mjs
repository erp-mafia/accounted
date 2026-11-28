export default {
  rule: 'paid-at-issue-account',
  says: 'A kontantfaktura is paid to a 19xx account, 1686, or an account a webshop store books a payment method to, on every door.',
  home: 'src/lib/invoices/paid-at-issue.ts: isPaidAtIssueAccount (the company\'s store accounts: src/lib/invoices/paid-at-issue-accounts.ts paidAtIssueAccountRefusal)',
  why: 'The schema, the MCP tool and the editor each said 19xx, so a card or Klarna sale could only be issued paid as money already in the bank (crm#2324).',
  match: [/paid_?at_?issue\w*[^\n]*\bisCashLedger\(/i, /\bisCashLedger\([^\n]*paid_?at_?issue/i],
  sanctioned: ['lib/invoices/paid-at-issue.ts', 'lib/invoices/paid-at-issue-accounts.ts'],
}
