export default {
  rule: 'income-output-vat-by-booking-source',
  says: 'A bank row booked by a category, a catalog template or a learned counterpart pair books its moms by bankRowVatLines: a sale credits net revenue and output VAT, and a refund takes the same back.',
  home: 'src/lib/bookkeeping/vat-entries.ts: bankRowVatLines',
  why: 'The category and the catalog template each wrote the moms of a bank row themselves, so a change to one reached the copy its author touched; the learned pair kept a copy that only knew purchases and booked every learned sale gross (crm#1632).',
  match: [/\bgenerateInputVatLine\b/, /\bvatLines\.push\(/, /\bvat_lines\.push\(/],
  scan: ['lib/bookkeeping/category-mapping.ts', 'lib/bookkeeping/booking-templates.ts', 'lib/bookkeeping/counterparty-templates.ts'],
}
