export default {
  rule: 'invoice-document-refusal',
  says: 'A bank row settles a faktura with no credit note against it: one reading of a credit note that counts, for the match doors, the batch, the link and the suggestion pool.',
  home: 'src/lib/transactions/invoice-document-refusal.ts: invoiceDocumentRefusal',
  why: 'Only the dashboard match refused an invoice with an active credit note, while the pool the matcher reads filtered the same invoices out, so v1, an approval, the batch and the link booked what the suggestion never offered.',
  match: [/creation_complete !== false/],
  sanctioned: ['lib/transactions/invoice-document-refusal.ts'],
  allowed: {
    'app/api/invoices/[id]/mark-paid/route.ts': 'mark paid is its own door, with its own rule in the invoice-mark-paid work.',
  },
}
