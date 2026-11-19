export default {
  rule: 'payment-cannot-exceed-remaining',
  says: 'A payment above what an invoice still owes is refused before anything books, unless an account for the excess is named.',
  home: 'src/lib/invoices/apply-invoice-payment.ts: planInvoicePayment; src/lib/invoices/apply-supplier-payment.ts: planSupplierPayment',
  why: 'Each hand-written copy clamped the remainder at zero with Math.max and booked the whole amount, so paid_amount passed the total and the excess vanished from the reskontra.',
  match: [/Math\.max\(\s*0,\s*(?:roundOre|Math\.round)\(\(?\s*[\w.]*[rR]emaining\w*(?:\.\w+)?\s*-/],
  sanctioned: ['lib/invoices/apply-invoice-payment.ts', 'lib/invoices/apply-supplier-payment.ts'],
  allowed: {
    'lib/invoices/voucher-matching.ts': 'The validator mirrors link_invoice_to_voucher, which refuses the overshoot first; the amount is already capped by the remainder.',
    'lib/invoices/supplier-voucher-matching.ts': 'The validator mirrors link_supplier_invoice_to_voucher, which refuses the overshoot first; the amount is already capped by the remainder.',
    'lib/arkiv/agreements/derive.ts': 'An instalment schedule of an agreement, not a payment on an invoice.',
    'components/transactions/InvoiceMatchDialog.tsx': 'What the dialog shows beside the preview; the match route plans the payment.',
  },
}
