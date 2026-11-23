export default {
  rule: 'supplier-invoice-rest-status',
  says: "The status an unpaid supplier invoice rests at has one answer, resolveUnsettledStatus: 'overdue' past its due date, 'approved' only with the attest mark (approved_at), else 'registered'.",
  home: 'src/lib/bookkeeping/supplier-invoice-rest-status.ts: resolveUnsettledStatus',
  why: "An undone credit read the registration verifikat as the attest and an undone payment set 'approved' outright, so an invoice nobody attested came back 'approved' and skipped attest (crm#2165), while the overdue cron and the SQL undo paths read approved_at.",
  match: [
    // status = 'approved' / newStatus = 'approved': a rest status picked by hand.
    /\b\w*[sS]tatus\s*=\s*['"]approved['"]/,
    // x ? 'approved' : 'registered', either way round and whatever x reads:
    // the rule's own tail, or the verifikat read as the attest.
    /['"]approved['"]\s*:\s*['"]registered['"]/,
    /['"]registered['"]\s*:\s*['"]approved['"]/,
    // .update({ status: 'approved' ... }): only the attest writes it, in SQL.
    /\.update\(\s*\{\s*status:\s*['"]approved['"]/,
  ],
  sanctioned: ['lib/bookkeeping/supplier-invoice-rest-status.ts'],
  // Where supplier invoices are written; salary runs keep their own 'approved'.
  scan: [
    'app/',
    'extensions/',
    'lib/bookkeeping/',
    'lib/company/',
    'lib/core/',
    'lib/import/',
    'lib/invoices/',
    'lib/operations/',
    'lib/payments/',
    'lib/supplier-invoices/',
    'lib/transactions/',
  ],
  allowed: {
    'lib/payments/orders/lifecycle.ts': "A payment order's own approval, not a supplier invoice's status.",
    'lib/payments/orders/signing.ts': "A payment order's own approval, not a supplier invoice's status.",
  },
}
