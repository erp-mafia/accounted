const needsItsOriginal = 'Routes a linked credit note to the path that needs its original; what has no link is refused further in by the identity.'
const wording = 'The wording of a document that reaches a customer: only a linked credit note is delivered, and an imported one keeps the title it was archived with.'

export default {
  rule: 'credit-note-identity',
  says: 'A credit note is a document with a link to its original or a total below zero, read the same by every list, gate, report and query.',
  home: 'src/lib/bookkeeping/credit-note-state.ts: isCreditNoteDocument',
  why: 'Each surface read one half of the rule, so three of four credit notes in production sat outside the Kreditfakturor view and an imported one read as paid.',
  match: [
    /\.is\(\s*['"]credited_invoice_id['"]\s*,\s*null\s*\)/,
    /credited_invoice_id\.not\.is\.null/,
    /\(Number\([\w.?]*\.total\)[^)]*\)\s*<\s*0/,
    /Number\([\w.?]*\.total(?: \?\? 0)?\)\s*<\s*0/,
    /\b\w+\??\.total\s*<\s*0/,
    /!!?\w+\??\.credited_invoice_id/,
    /\.credited_invoice_id\s*\|\|/,
    /Boolean\([\w.?]*\.credited_invoice_id\)/,
    /\bif \(\w+\??\.credited_invoice_id\) return\b/,
  ],
  sanctioned: ['lib/bookkeeping/credit-note-state.ts'],
  allowed: {
    'app/(dashboard)/invoices/[id]/page.tsx': 'Which credit note points here, and the delete dialog and toast for a linked draft: reads of the link.',
    'app/api/invoices/[id]/mark-sent/route.ts': needsItsOriginal,
    'app/api/invoices/[id]/send/route.ts': needsItsOriginal,
    'app/api/invoices/[id]/pdf/route.ts': wording,
    'components/invoices/SendInvoiceDialog.tsx': needsItsOriginal,
    'components/invoices/InvoiceEditor.tsx': 'Deductions used on the customer: a row with a deduction is no credit note, and this needs no second filter.',
    'extensions/general/arcim-migration/lib/migration-job-worker.ts': 'A write that fills the link where it is empty.',
    'lib/bookkeeping/registered-from-books.ts': 'A linked credit note on a registration has no rows of its own: a read of the link.',
    'lib/email/invoice-templates.ts': wording,
    'lib/invoices/book-invoice-deferred.ts': 'A compare-and-set on a write: the refusal by identity runs before it.',
    'lib/invoices/is-editable-draft.ts': 'A linked draft mirrors its original; an unlinked one mirrors nothing and stays editable.',
    'lib/invoices/pdf-template.tsx': wording,
    // The v1 download's loader, shared with gnubok_get_invoice_pdf (crm#1593).
    'lib/invoices/stored-invoice-pdf.ts': wording,
    'lib/invoices/sync-draft-vat-headers.ts': 'A linked draft keeps the VAT of the original it mirrors; an unlinked one has none to keep.',
  },
}
