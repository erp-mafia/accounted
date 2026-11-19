export default {
  rule: 'invoice-shown-status',
  says: 'The status a customer invoice shows or reports follows the due date and the open remainder, never the stored status alone: a screen asks invoiceRowStatus, an API or MCP answer effectiveInvoiceStatus.',
  home: 'src/lib/invoices/status-display.ts: invoiceRowStatus',
  why: 'Overdue is derived, never stored (crm#1084), and each surface that mapped the stored status by hand missed it: an invoice stored as sent, past due with money left, read overdue in the list, on the customer card and in v1 /invoices, and sent on the invoice page, on the sales order and in the v1 customer expand. A sent credit note read Skickad on its own page and Kredit in the list.',
  match: [
    // invoiceStatusDisplay(invoice.status): the label of the stored status.
    /invoiceStatusDisplay\(\s*[\w.?]+\.status\s*\)/,
    // invoice.status === 'overdue': the stored label read as the overdue fact.
    /\b\w*[iI]nv(?:oice)?\w*\??\.status\s*===\s*['"]overdue['"]/,
    // isInvoiceOverdue(invoice) ? ... : a label picked by hand from the overdue fact.
    /\bisInvoiceOverdue\([^()]*\)\s*\?/,
  ],
  sanctioned: ['lib/invoices/status-display.ts', 'lib/invoices/overdue.ts'],
  // The surfaces. lib/ compares the stored status to decide what may be booked or matched
  // (owed-invoice-population names those sites), which is not what an invoice shows.
  scan: ['app/', 'components/', 'extensions/'],
}
