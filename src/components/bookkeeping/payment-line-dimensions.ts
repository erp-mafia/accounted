/**
 * Dimension bags on the editable rows of a payment verifikat: the customer
 * mark-paid dialog (PaymentBookingDialog), the bank-match dialog
 * (InvoiceMatchDialog) and the supplier invoice's mark-paid dialog.
 *
 * One rule for all of them, set by dimensions PR7 in PaymentBookingDialog:
 * a proposed row keeps the bag it came with through every edit of its
 * account, side, amount or text, a row the user adds starts with the settled
 * document's bag (as the server does for a line it adds to the same payment),
 * and what the grid holds is what gets booked. An empty bag is left off, so
 * an untagged row stays untagged.
 */
export type LineDimensions = Record<string, string>

/**
 * `{ dimensions }` holding a copy of a non-empty bag, else `{}`. Spread it
 * into a row or a request line; the copy keeps one row's bag from leaking
 * into another.
 */
export function withLineDimensions(
  bag: LineDimensions | null | undefined,
): { dimensions?: LineDimensions } {
  return bag && Object.keys(bag).length > 0 ? { dimensions: { ...bag } } : {}
}
