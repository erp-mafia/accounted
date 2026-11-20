export default {
  rule: 'invoice-issue',
  says: 'Whether a draft can be issued has one answer on every door.',
  home: 'src/lib/invoices/issue-and-book-invoice.ts: issuable',
  why: 'Each door kept its own list of refusals: v1 mark-sent and send refused every sale of a company outside the VAT register and advised a re-creation that could not help, while the dashboard and MCP issued it.',
  match: [/!\w+\??\.moms_ruta\b/, /hasRequiredSellerVatNumber\(/],
  sanctioned: ['lib/invoices/issue-and-book-invoice.ts', 'lib/invoices/seller-vat-number.ts'],
  allowed: {
    'components/invoices/InvoiceEditor.tsx': 'A hint in the editor for a document not yet saved: it asks before there is a row to refuse.',
  },
}
