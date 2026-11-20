export default {
  rule: 'invoice-due-date-from-terms',
  says: "A due date left out is the invoice date plus the terms in calendar days; the terms are the customer's, then the company default, then 30.",
  home: 'src/lib/dates/iso.ts: invoiceDueDate; src/lib/invoices/due-date.ts: invoiceTermsFor',
  why: 'three doors added days with a local setDate, one day short across the spring clock change, and four skipped the company default',
  match: [
    /default_payment_terms\s*(?:\?\?|\|\|)\s*\d/,
    /\.set(?:UTC)?Date\(.*(?:payment_?[tT]erms|[tT]ermsDays|\bterms\b)/,
    /\baddDays(?:Iso)?\([^)]*(?:payment_?[tT]erms|[tT]ermsDays|\bterms\b)/,
  ],
  sanctioned: ['lib/dates/iso.ts', 'lib/invoices/due-date.ts'],
  allowed: {
    'app/(dashboard)/customers/[id]/page.tsx': 'shows the card, which has terms in every row: no due date is decided here',
    'components/customers/CustomerForm.tsx': "the form's starting value: the new-customer page passes the company default in",
    'components/suppliers/SupplierForm.tsx': "the form's starting value for a supplier card",
  },
}
