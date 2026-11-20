export default {
  rule: 'inbox-convert',
  says: 'Turning an inbox item into a supplier invoice keeps the same notes, emits the same events and refuses the same items on every door.',
  home: 'src/lib/operations/inbox-convert.ts: convertInboxItemToSupplierInvoice',
  why: 'The approval of a staged conversion was a 640-line copy: it dropped the channel context from the notes, emitted one event of two, knew no pair guard and rounded the header by hand.',
  match: [
    /type:\s*'supplier_invoice\.confirmed'/,
    /\.update\(\{ created_supplier_invoice_id/,
  ],
  sanctioned: ['lib/operations/inbox-convert.ts'],
  allowed: {
    'lib/events/types.ts': 'the event declared: nothing is registered.',
    'lib/supplier-invoices/create.ts': 'a privately paid purchase settled from its inbox item: an utlägg, not a payable.',
    'lib/supplier-invoices/credit.ts': 'a credit note consumed by the credit of its invoice, never a payable of its own.',
  },
}
