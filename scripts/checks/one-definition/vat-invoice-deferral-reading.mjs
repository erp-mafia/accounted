export default {
  rule: 'vat-invoice-deferral-reading',
  says: 'The momsdeklaration reads a förutbetald intäkt an invoice booked with moms as the sale on the invoice\'s date and leaves its releases out: the SQL decides which verifikat (vat_invoice_deferral_shares, the invoice_deferral_release reason), and a TS fold over one verifikat\'s lines reads it through fetchInvoiceDeferralShares and readDeferredSaleLines.',
  home: 'src/lib/reports/vat-declaration.ts: fetchInvoiceDeferralShares, readDeferredSaleLines (SQL: public.vat_invoice_deferral_shares, migration 20261121140000)',
  why: 'The declaration read ruta 05 off the revenue accounts alone, so a periodiserad invoice line was missing from the period that carried its moms and counted, with no moms, in each release month (crm#1919).',
  match: [
    // supabase.rpc('vat_invoice_deferral_shares', ...): a second reader of the
    // shares, which then maps the lines by hand.
    /\bvat_invoice_deferral_shares\b/,
  ],
  sanctioned: ['lib/reports/vat-declaration.ts'],
}
