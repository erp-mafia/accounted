export default {
  rule: 'fortnox-supplier-booking-voucher',
  says: 'The verifikat that booked a Fortnox supplier invoice is the one SUPPLIERINVOICE reference in its Vouchers list, read the same by the migration and the document import.',
  home: 'src/lib/providers/fortnox/supplier-invoice-voucher.ts: fortnoxSupplierInvoiceBookingParts',
  why: 'The migration read only the top-level voucher fields, which Fortnox fills in the bookkeep response alone, so no migrated supplier invoice was ever linked to its verifikat while the document import read the list right.',
  match: [
    /['"]SUPPLIERINVOICE['"]/,
  ],
  sanctioned: ['lib/providers/fortnox/supplier-invoice-voucher.ts'],
  allowed: {},
}
