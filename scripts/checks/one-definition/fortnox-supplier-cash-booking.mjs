export default {
  rule: 'fortnox-supplier-cash-booking',
  says: 'Under kontantmetoden the verifikat that booked a Fortnox supplier invoice is its one SUPPLIERPAYMENT voucher, taken only when the invoice names no SUPPLIERINVOICE voucher, the payment is in a CASH financial year, the invoice is settled to the öre (fortnoxSupplierInvoiceSettled) and Fortnox does not mark it booked; read for the invoice\'s file, never for its registration.',
  home: 'src/lib/providers/fortnox/supplier-invoice-voucher.ts: fortnoxSupplierInvoiceCashBookingParts, gated in attachments.ts: fetchFortnoxSupplierInvoiceBookingVoucher',
  why: 'The document import took only a SUPPLIERINVOICE voucher as the booking, so a kontantmetod company lost every supplier-invoice file without a count.',
  match: [
    /['"]SUPPLIERPAYMENT['"]/,
  ],
  sanctioned: ['lib/providers/fortnox/supplier-invoice-voucher.ts'],
  allowed: {},
}
