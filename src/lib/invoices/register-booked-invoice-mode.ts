/**
 * The marker a staged create_invoice operation carries when it registers an
 * invoice that is already booked (gnubok_register_booked_invoice, crm#1094)
 * instead of creating a draft. The two share the pending type, so every
 * surface that tells them apart (the commit dispatcher, the approval
 * sentence, the bulk approval toast) reads this one marker.
 *
 * Its own module with no imports: the approval UI is client code and must not
 * pull the server-side registration logic into its bundle.
 */
export const REGISTER_BOOKED_INVOICE_MODE = 'register_booked'

/** True for the params or preview of a staged registration of an already-booked invoice. */
export function isRegisterBookedInvoiceParams(params: Record<string, unknown> | null | undefined): boolean {
  return params?.mode === REGISTER_BOOKED_INVOICE_MODE
}
