export default {
  rule: 'supplier-invoice-to-pay',
  says: 'Which supplier invoices wait to be paid has one answer: the Att betala tab, the Att göra Betala row and status=to_pay all ask waitsToBePaid.',
  home: 'src/lib/supplier-invoices/to-pay.ts: waitsToBePaid',
  why: 'The tab counted every payable status, the Att göra row only attested invoices and the API the statuses Markera som betald is offered for: Att göra said Betala 1 and the tab it opens showed 3.',
  match: [
    // .in('status', [...payableSupplierInvoiceStatuses(method)]): the old to_pay filter.
    /\.in\(\s*'status'\s*,\s*\[\s*\.\.\.payableSupplierInvoiceStatuses\(/,
    // PAYABLE.has(invoice.status) && !invoice.auto_debit: the old tab, spelled out.
    /PAYABLE\.has\(\s*[\w.?]+\.status\s*\)\s*(?:&&|\|\|)\s*!?\s*[\w.?]+\.auto_debit/,
    // companyAttestsSupplierInvoices(method) && !invoice.approved_at: the old Att göra gate.
    /companyAttestsSupplierInvoices\([^)]*\)\s*&&\s*![\w.?]+\.approved_at/,
  ],
  sanctioned: ['lib/supplier-invoices/to-pay.ts'],
  allowed: {
    'lib/supplier-invoices/manage.ts':
      'The compare-and-set of the "Inlagd i banken" tick: the statuses the tick may be set in (canMarkSupplierInvoiceBankEntered), not what waits to be paid.',
  },
}
