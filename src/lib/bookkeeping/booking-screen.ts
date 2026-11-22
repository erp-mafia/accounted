/**
 * The booking screen's address (/bokfor) and what it books: a bank row
 * (`?transaktion=<id>`, optionally with the counter account the person
 * already picked, `&konto=5460`) or a new verifikation with no bank row
 * (no query). Pure, so the doors that link here and the page that reads
 * the address agree on one shape.
 */
import { isUuid } from '@/lib/invariants/uuid'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'

export const BOOKING_SCREEN_PATH = '/bokfor'

export type BookingScreenSubject =
  | { kind: 'transaction'; transactionId: string; account: string | null }
  | { kind: 'voucher' }

type QueryValue = string | string[] | undefined

function first(value: QueryValue): string | null {
  const v = Array.isArray(value) ? value[0] : value
  const trimmed = v?.trim()
  return trimmed ? trimmed : null
}

/** The screen's address for a subject. */
export function bookingScreenHref(subject: BookingScreenSubject): string {
  if (subject.kind === 'voucher') return BOOKING_SCREEN_PATH
  const params = new URLSearchParams({ transaktion: subject.transactionId })
  if (subject.account) params.set('konto', subject.account)
  return `${BOOKING_SCREEN_PATH}?${params.toString()}`
}

/**
 * What the address asks to book. A transaction id that is not a uuid, or an
 * account that is not four digits, is dropped rather than trusted: a broken
 * link opens an empty verifikation instead of a lookup on garbage.
 */
export function parseBookingScreenSubject(query: { transaktion?: QueryValue; konto?: QueryValue }): BookingScreenSubject {
  const transactionId = first(query.transaktion)
  if (!transactionId || !isUuid(transactionId)) return { kind: 'voucher' }
  const account = first(query.konto)
  return { kind: 'transaction', transactionId: transactionId.toLowerCase(), account: account && ACCOUNT_NUMBER_RE.test(account) ? account : null }
}
