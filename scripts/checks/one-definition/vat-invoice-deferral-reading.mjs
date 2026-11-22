export default {
  rule: 'vat-invoice-deferral-reading',
  says: 'The momsdeklaration reads every interim line (17xx or 29xx) of a verifikat that books a periodisering an invoice booked with moms, a förutbetald intäkt on 29xx or an upplupen intäkt on 17xx (the invoice, its kreditfaktura, the months of its schedules, the months of a manual periodisering spread out of what a rättelse added to its lines of the plan\'s interim class, and every storno and rättelse of these), as the sale on its revenue account at the part of its interim class (share for 29xx lines, accrued_share for 17xx lines; a month\'s part reads both): the invoice reports the sale on its own date, a month nets to nothing. The SQL decides which verifikat and at which part (vat_invoice_deferral_shares), and a TS fold over one verifikat\'s lines reads it through fetchInvoiceDeferralShares and readDeferredSaleLines.',
  home: 'src/lib/reports/vat-declaration.ts: fetchInvoiceDeferralShares, readDeferredSaleLines (SQL: public.vat_invoice_deferral_shares, migrations 20261122140000 and 20261122200000)',
  why: 'The declaration read ruta 05 off the revenue accounts alone, so a periodiserad invoice line was missing from the period that carried its moms and counted, with no moms, in each month of its periodisering: the release months of a förutbetald intäkt and the months before the invoice of an upplupen intäkt (crm#1919).',
  match: [
    // supabase.rpc('vat_invoice_deferral_shares', ...): a second reader of the
    // shares, which then maps the lines by hand.
    /\bvat_invoice_deferral_shares\b/,
  ],
  sanctioned: ['lib/reports/vat-declaration.ts'],
}
