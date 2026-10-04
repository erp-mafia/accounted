/**
 * The journal-entry source types that mean "Accounted booked this payment
 * itself".
 *
 * One list, because it draws a boundary two different undo paths share and a
 * disagreement between them is silent data corruption:
 *
 *   * an entry WITH one of these types is storno's: reverseEntry reverses the
 *     entry and clears the payment row together
 *     (lib/bookkeeping/payment-sync.ts);
 *   * an entry with any other type is a pure subledger pointer written by the
 *     link RPCs, and unlink_supplier_invoice_from_voucher owns it.
 *
 * It lives in its own module so a client component can read it without
 * pulling in the Supabase server client that payment-sync imports. The SQL
 * copy inside the unlink RPC is pinned against this list by
 * tests/pg/unlink-supplier-invoice-from-voucher.pg.test.ts.
 */
export const PAYMENT_SOURCE_TYPES = [
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
] as const

export type PaymentSourceType = (typeof PAYMENT_SOURCE_TYPES)[number]

export function isPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return (PAYMENT_SOURCE_TYPES as readonly string[]).includes(sourceType)
}
