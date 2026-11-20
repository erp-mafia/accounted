export default {
  rule: 'supplier-payment-settlement',
  says: 'Recording a supplier payment by hand runs one plan and one write path: the refusals, the ledger math, the voucher, the payment row, the status.',
  home: 'src/lib/invoices/settle-supplier-payment.ts: planSupplierSettlement, bookSupplierSettlement',
  why: 'The dashboard and v1 each held the whole sequence: the dashboard let 1500 clear 2440 on a remaining 1000 and paid credit notes, v1 only warned when its payment row failed.',
  match: [/\bcreateSupplierInvoice(?:Payment|Cash)Entry\(/],
  sanctioned: [
    'lib/invoices/settle-supplier-payment.ts',
    'lib/bookkeeping/supplier-invoice-entries.ts',
    'lib/bookkeeping/supplier-bank-match-entry.ts',
  ],
}
