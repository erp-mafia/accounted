export default {
  rule: 'invoice-line-quantity',
  says: 'An invoice product row takes any number as quantity, except a positive one on a skattereduktion row and a non-negative one on a sales order row, on every door.',
  home: 'src/lib/invoices/line-quantity.ts: lineQuantityIssue',
  why: 'Four doors and the editor hint each kept "positive" as their own copy, so a 0 x 0 information row and a negative-quantity deduction were refused everywhere while credit notes stored negative quantities (#3553).',
  match: [/\bquantity\s*>=\s*0\.01\b/, /\bitem\.quantity\s*<=\s*0\b/],
  scan: ['components/invoices/', 'lib/invoices/', 'lib/api/schemas.ts', 'extensions/general/mcp-server/'],
  sanctioned: ['lib/invoices/line-quantity.ts'],
  allowed: {
    'components/invoices/NewRecurringScheduleDialog.tsx': 'A recurring schedule row is another rule: its own DB check keeps the quantity above 0.',
    'lib/api/schemas.ts': 'RecurringInvoiceItemSchema mirrors that DB check (quantity above 0); the invoice row schema calls lineQuantityIssue.',
  },
}
