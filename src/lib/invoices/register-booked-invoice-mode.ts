/**
 * The marker a staged operation carries when it registers an invoice that is
 * already booked (crm#1094) instead of creating one that gets booked:
 * gnubok_register_booked_invoice under the create_invoice pending type, and
 * gnubok_register_booked_supplier_invoice under
 * create_supplier_invoice_from_inbox. Each shares its pending type, so every
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

/** The reskontra a registration of an already-booked invoice goes into. */
export type RegisterBookedLedger = 'customer' | 'supplier'

/** The pending type each ledger's registration is staged under. */
const REGISTER_BOOKED_PENDING_TYPES: ReadonlyMap<string, RegisterBookedLedger> = new Map([
  ['create_invoice', 'customer'],
  ['create_supplier_invoice_from_inbox', 'supplier'],
])

/** Which reskontra a staged operation registers an already-booked invoice into, or null when it does not. */
export function registerBookedLedgerOf(
  operationType: string,
  params: Record<string, unknown> | null | undefined,
): RegisterBookedLedger | null {
  return isRegisterBookedInvoiceParams(params) ? REGISTER_BOOKED_PENDING_TYPES.get(operationType) ?? null : null
}
