export default {
  rule: 'supplier-invoice-list-search',
  says: "What the supplier invoice list search finds has one answer: the supplier's name and the invoice, Fortnox and ankomst numbers as typed, the payment reference as typed or on its digits, and whether a row was found by its reference alone.",
  home: 'src/lib/supplier-invoices/list-search.ts: supplierInvoiceMatchesSearch',
  why: 'The list searched inline and missed the OCR, the one number a bank row or a payment advice may carry; every line that says what the search found must find the rows the list shows.',
  match: [
    // (inv.supplier_invoice_number ?? '').toLowerCase().includes(query): the search the list wrote inline.
    /\bsupplier_invoice_number\s*\?\?\s*''\s*\)\s*\.toLowerCase\(\)\s*\.includes\(/,
    // (inv.payment_reference ?? '').toLowerCase().includes(query), or ?.toLowerCase(): the reference searched by hand.
    /\bpayment_reference\s*(?:\?\?\s*''\s*\)|\?)\s*\.toLowerCase\(\)\s*\.includes\(/,
  ],
  sanctioned: ['lib/supplier-invoices/list-search.ts'],
}
