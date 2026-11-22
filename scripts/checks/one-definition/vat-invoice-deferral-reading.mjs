export default {
  rule: 'vat-invoice-deferral-reading',
  says: 'The momsdeklaration reads every 29xx line of a verifikat that books a förutbetald intäkt an invoice booked with moms (the invoice, its kreditfaktura, its releases and every storno and rättelse of these) as the sale on its revenue account: the invoice reports the sale on its own date, a release nets to nothing. The SQL decides which verifikat and at which part (vat_invoice_deferral_shares), and a TS fold over one verifikat\'s lines reads it through fetchInvoiceDeferralShares and readDeferredSaleLines.',
  home: 'src/lib/reports/vat-declaration.ts: fetchInvoiceDeferralShares, readDeferredSaleLines (SQL: public.vat_invoice_deferral_shares, migration 20261121140000)',
  why: 'The declaration read ruta 05 off the revenue accounts alone, so a periodiserad invoice line was missing from the period that carried its moms and counted, with no moms, in each release month (crm#1919).',
  match: [
    // supabase.rpc('vat_invoice_deferral_shares', ...): a second reader of the
    // shares, which then maps the lines by hand.
    /\bvat_invoice_deferral_shares\b/,
  ],
  sanctioned: ['lib/reports/vat-declaration.ts'],
}
