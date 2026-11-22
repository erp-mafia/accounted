/**
 * The quantity rule for a product row on an invoice, quote or proforma, one
 * definition for every door (the editor, its next-step hint, the API schema
 * and the MCP tools).
 *
 * Zero and negative quantities are allowed (#3553), as negative unit prices
 * always were: a 0 x 0 row carries information on a Peppol invoice, where
 * text rows do not travel, and a negative quantity at a positive price is the
 * line deduction EN 16931 accepts (BR-27 refuses only a negative item price).
 *
 * Two rows keep a positive quantity:
 *  - a row with a skattereduktion (ROT, RUT, grön teknik): each claim sums
 *    its positive rows only (computeDeduction gives a row that nets to zero
 *    or less no deduction) and adds every row's hours, so a negative row
 *    would leave the claim and its hours above the work actually billed;
 *  - a row from a sales order line, refused only when negative: the order
 *    counts invoiced quantities by summing them, so a negative row would
 *    lower what it counts as invoiced.
 */
export type LineQuantityIssue = 'not_a_number' | 'deduction_needs_positive' | 'negative_on_order_line'

export function lineQuantityIssue(item: {
  quantity?: number | null
  deduction_type?: string | null
  sales_order_item_id?: string | null
}): LineQuantityIssue | null {
  const quantity = item.quantity
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) return 'not_a_number'
  if (item.deduction_type && quantity <= 0) return 'deduction_needs_positive'
  if (item.sales_order_item_id && quantity < 0) return 'negative_on_order_line'
  return null
}

/** The API's English message per issue (the editor translates its own). */
export const LINE_QUANTITY_MESSAGES: Record<LineQuantityIssue, string> = {
  not_a_number: 'Quantity must be a number',
  deduction_needs_positive: 'A row with a tax deduction (ROT, RUT, grön teknik) needs a positive quantity',
  negative_on_order_line: 'Quantity on a sales order line cannot be negative',
}
