export default {
  rule: 'owed-invoice-population',
  says: 'Which customer invoices are still owed has one list of statuses, and a query for what is owed goes through filterOwedInvoices.',
  home: 'src/lib/bookkeeping/matchable-statuses.ts: OWED_INVOICE_STATUSES',
  why: 'Over twenty copies of the list agreed by luck, and the readers that drifted told an agent a draft was open receivables and a v1 caller that a sent credit note was an open invoice.',
  match: [/(?=.*['"]sent['"])(?=.*['"]overdue['"])(?=.*['"]partially_paid['"])/],
  sanctioned: ['lib/bookkeeping/matchable-statuses.ts'],
  allowed: {
    'app/(dashboard)/invoices/page.tsx': 'The kinds of a row status line, not stored statuses: a kind says overdue from the due date.',
    'app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route.ts': 'The response schema: it lists the statuses a payment can leave, paid first, in published order.',
    'extensions/general/mcp-server/server.ts': 'The schema of a status filter: every status a caller can ask for.',
  },
}
