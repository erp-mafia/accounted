export default {
  rule: 'income-output-vat-by-booking-source',
  says: 'A bank row booked by a category or a catalog template books its moms by bankRowVatLines: a sale credits net revenue and output VAT, and a refund takes the same back.',
  home: 'src/lib/bookkeeping/vat-entries.ts: bankRowVatLines',
  why: 'The category and the catalog template each wrote the moms of a bank row themselves, so a change to one reached the copy its author touched.',
  match: [/\bgenerateInputVatLine\b/, /\bvatLines\.push\(/, /\bvat_lines\.push\(/],
  scan: ['lib/bookkeeping/category-mapping.ts', 'lib/bookkeeping/booking-templates.ts'],
}
