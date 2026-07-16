/**
 * Display a personal identity number without exposing birth date or full ID.
 */
export function maskCustomerPersonalNumber(value: string | null | undefined): string | null {
  if (!value) return null
  const last4 = value.replace(/\D/g, '').slice(-4)
  return last4.length === 4 ? `********-${last4}` : null
}
