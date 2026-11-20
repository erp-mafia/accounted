export default {
  rule: 'invoice-payable',
  says: 'Which customer documents take a payment on which date has one answer on every door.',
  home: 'src/lib/invoices/invoice-payable.ts: invoicePayableRefusal',
  why: 'The dashboard refused an invoice with a credit note draft, v1 refused a följesedel, and MCP refused neither: the same document was paid or refused by the door it came through.',
  match: [/['"]INVOICE_(?:QUOTE|PAID)_NOT_PAYABLE['"]/],
  sanctioned: ['lib/invoices/invoice-payable.ts'],
  allowed: {
    'lib/invoices/issue-and-book-invoice.ts': 'Names the refusal in the code type of its result; the answer comes from settleInvoicePayment.',
    'lib/pending-operations/commit.ts': 'Maps the refusal of settleInvoicePayment to a state refusal of the approval.',
  },
}
