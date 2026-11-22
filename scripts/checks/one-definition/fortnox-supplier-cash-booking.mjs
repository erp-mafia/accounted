export default {
  rule: 'fortnox-supplier-cash-booking',
  says: 'Under kontantmetoden the verifikat that booked a Fortnox supplier invoice is its one SUPPLIERPAYMENT voucher, and only when it names no SUPPLIERINVOICE voucher; read for the invoice\'s file, never for its registration.',
  home: 'src/lib/providers/fortnox/supplier-invoice-voucher.ts: fortnoxSupplierInvoiceCashBookingParts',
  why: 'The document import took only a SUPPLIERINVOICE voucher as the booking, so a kontantmetod company lost every supplier-invoice file without a count.',
  match: [
    /['"]SUPPLIERPAYMENT['"]/,
  ],
  sanctioned: ['lib/providers/fortnox/supplier-invoice-voucher.ts'],
  allowed: {},
}
