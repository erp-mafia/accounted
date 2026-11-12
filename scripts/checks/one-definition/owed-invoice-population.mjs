export default {
  rule: 'owed-invoice-population',
  says: 'Which customer invoices are still owed has one list of statuses: a query for what is owed goes through filterOwedInvoices, a row already read through isInvoiceOwed.',
  home: 'src/lib/bookkeeping/matchable-statuses.ts: OWED_INVOICE_STATUSES',
  why: 'Over twenty copies of the list agreed by luck, and the readers that drifted told an agent a draft was open receivables and a v1 caller that a sent credit note was an open invoice. A list of two, sent and overdue, slipped past the first guard: the Obetalda view left out every partly paid invoice with money left.',
  match: [
    /(?=.*['"]sent['"])(?=.*['"]overdue['"])(?=.*['"]partially_paid['"])/,
    // ['sent', 'overdue']: the owed list short of the partly paid.
    /\[\s*['"]sent['"]\s*,\s*['"]overdue['"]\s*\]/,
    // status === 'sent' || status === 'overdue': the same pair as a comparison, and its negation.
    /status\s*===\s*['"]sent['"]\s*\|\|\s*[\w.?]*status\s*===\s*['"]overdue['"]/,
    /status\s*!==\s*['"]sent['"]\s*&&\s*[\w.?]*status\s*!==\s*['"]overdue['"]/,
  ],
  // overdue.ts holds the other half of the home (filterOwedInvoices, isInvoiceOwed) and is where
  // the pair itself is the rule: sent and the legacy stored overdue follow the due date.
  sanctioned: ['lib/bookkeeping/matchable-statuses.ts', 'lib/invoices/overdue.ts'],
  allowed: {
    'app/(dashboard)/invoices/page.tsx':
      'The kinds of a row status line, not stored statuses: a kind says overdue from the due date. And the bulk Bokför selection: the statuses a sale is booked afterwards in (INVOICE_BOOKABLE_STATUSES).',
    'app/(dashboard)/invoices/[id]/page.tsx':
      'canBookAfterwards: the statuses a sale is booked afterwards in (INVOICE_BOOKABLE_STATUSES), before any payment reached the invoice.',
    'app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route.ts': 'The response schema: it lists the statuses a payment can leave, paid first, in published order.',
    'extensions/general/mcp-server/server.ts': 'The schema of a status filter: every status a caller can ask for.',
    'lib/bookkeeping/payment-sync.ts':
      'The compare-and-set of a refund reversal on a credit note: the statuses an issued credit note rests in (REFUNDABLE_CREDIT_NOTE_STATUSES), never an owed invoice.',
    'lib/invoices/book-customer-bank-match.ts':
      'The double-booking guard: an invoice that reads unpaid yet carries a payment voucher is refused, while a partly paid one takes further payments.',
    'lib/invoices/book-invoice-deferred.ts':
      'INVOICE_BOOKABLE_STATUSES: the sale is booked afterwards only before any payment; a paid or partly paid invoice without a verifikat is corrected, never booked here.',
    'lib/invoices/credit-note-refund-plan.ts': 'REFUNDABLE_CREDIT_NOTE_STATUSES: the statuses an issued credit note rests in. A credit note is never partly paid.',
    'lib/invoices/invoice-matching.ts':
      'The double-booking guard of book-customer-bank-match.ts, for the suggestions: only an invoice that reads unpaid is checked for a payment voucher.',
    'lib/invoices/migrated-deduction-plan.ts':
      'The status repair of a migrated invoice: one that reads unpaid with a part paid is the one whose status is wrong.',
    'lib/invoices/peppol-health.ts':
      'A retryable Peppol failure is an alert only on an issued invoice that can still be handed to the network (SENDABLE_STATUSES in peppol-send-service.ts, less the draft).',
    'lib/invoices/resend-eligibility.ts':
      'Skicka igen (crm#1339): the copy repeats the amount to pay, so a partly paid invoice is left out on purpose.',
    'lib/invoices/status-display.ts':
      'The status line: sent and the legacy stored overdue are the pair that follows the due date, and partly paid reads as partly paid first.',
  },
}
