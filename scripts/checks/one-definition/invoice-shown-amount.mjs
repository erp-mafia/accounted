export default {
  rule: 'invoice-shown-amount',
  says: 'The amount a row or a dialog prints for a customer invoice is getDisplayTotal or getAmountToPay (öresavrundning and the ROT/RUT deduction applied), never the raw total.',
  home: 'src/lib/bookkeeping/invoice-rounding.ts: getDisplayTotal',
  why: 'The invoice list, the PDF and the mail said 18 563 kr where the customer card, the sales order and the payment dialog said 18 562,50 kr, and the send dialog said 25 000 kr above a mail that asked for 17 500 kr after the ROT deduction.',
  match: [
    // formatCurrency(invoice.total, invoice.currency), formatCurrency(Number(inv.total), inv.currency)
    /formatCurrency\(\s*(?:Number\(\s*)?(?:\w+\??\.)*\w*[iI]nv(?:oice)?\w*\??\.total\b\s*\)?\s*,\s*[\w.?]+\.currency\b/,
  ],
  sanctioned: ['lib/bookkeeping/invoice-rounding.ts'],
  allowed: {
    'components/supplier-invoices/AttestBatchPage.tsx':
      'A supplier invoice: what it shows is a rule of its own (supplierInvoiceDisplayFigures), with no company-wide öresavrundning.',
    'components/supplier-invoices/AttestLinkPage.tsx':
      'A supplier invoice: what it shows is a rule of its own (supplierInvoiceDisplayFigures), with no company-wide öresavrundning.',
  },
  // The surfaces that print an amount: pages and components.
  scan: ['app/', 'components/'],
}
