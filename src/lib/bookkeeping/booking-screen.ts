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

/** The pages the screen returns to, with the list's own query (filters, search, page) kept. */
const RETURN_PATHS = ['/bookkeeping', '/transactions'] as const

/**
 * A return address the screen may follow: a path on one of the pages it
 * returns to, never another host (`//x`), another page or a backslash
 * trick. Anything else is dropped.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  const path = raw?.trim()
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null
  const known = RETURN_PATHS.some((p) => path === p || path.startsWith(`${p}?`) || path.startsWith(`${p}/`))
  return known ? path : null
}

/**
 * The screen's address for a subject, with the page to return to after
 * booking when it is one the screen may return to (`tillbaka`).
 */
export function bookingScreenHref(subject: BookingScreenSubject, back?: string | null): string {
  const params = new URLSearchParams()
  if (subject.kind === 'transaction') {
    params.set('transaktion', subject.transactionId)
    if (subject.account) params.set('konto', subject.account)
  }
  const returnTo = safeReturnPath(back)
  if (returnTo) params.set('tillbaka', returnTo)
  const qs = params.toString()
  return qs ? `${BOOKING_SCREEN_PATH}?${qs}` : BOOKING_SCREEN_PATH
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

/** The page to return to after booking, when the address names a safe one. */
export function parseBookingScreenBack(query: { tillbaka?: QueryValue }): string | null {
  return safeReturnPath(first(query.tillbaka))
}
