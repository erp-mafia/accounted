export default {
  rule: 'supplier-invoice-rest-status',
  says: "The status an unpaid supplier invoice rests at has one answer, resolveUnsettledStatus: 'overdue' past its due date, 'approved' only with the attest mark (approved_at), else 'registered'.",
  home: 'src/lib/supplier-invoices/lifecycle.ts: resolveUnsettledStatus',
  why: "An undone credit read the registration verifikat as the attest and an undone payment set 'approved' outright, so an invoice nobody attested came back 'approved' and skipped attest (crm#2121), while the overdue cron and the SQL undo paths read approved_at.",
  match: [
    // status = 'approved' / newStatus = 'approved': a rest status picked by hand.
    /\b\w*[sS]tatus\s*=\s*['"]approved['"]/,
    // invoice.approved_at ? 'approved' : 'registered': the rule's own tail, copied.
    /approved_at\s*\?\s*['"]approved['"]\s*:\s*['"]registered['"]/,
  ],
  sanctioned: ['lib/supplier-invoices/lifecycle.ts'],
  allowed: {
    'lib/salary/book-run.ts': "A salary run's own status, not a supplier invoice's.",
  },
}
