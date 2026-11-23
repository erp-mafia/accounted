/**
 * The booking screen's address (/bokfor) and what it books: a bank row
 * (`?transaktion=<id>`, optionally with the counter account the person
 * already picked, `&konto=5460`, or the inbox item found for the row,
 * `&underlag=<id>`, held as its underlag) or a new verifikation with no bank
 * row (no query). Pure, so the doors that link here and the page that reads
 * the address agree on one shape.
 */
import { isUuid } from '@/lib/invariants/uuid'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { safeReturnTo } from '@/lib/auth/safe-return-to'

export const BOOKING_SCREEN_PATH = '/bokfor'

export type BookingScreenSubject =
  | {
      kind: 'transaction'
      transactionId: string
      account: string | null
      /** The inbox item found for the row (Att bokföra's Kvitto hittat), held as its underlag until Bokför. */
      foundItemId?: string | null
      /** A proposal the person picked waits for the screen (booking-screen-pick.ts): it opens with it used. */
      picked?: boolean
    }
  | { kind: 'voucher' }

type QueryValue = string | string[] | undefined

function first(value: QueryValue): string | null {
  const v = Array.isArray(value) ? value[0] : value
  const trimmed = v?.trim()
  return trimmed ? trimmed : null
}

/**
 * The pages the screen returns to, with the list's own query (filters,
 * search, page) kept. Each is a menu row: the screen keeps the one it was
 * opened from lit (bookingScreenOrigin). Hem is one menu row whatever its
 * view (`/`, a Börja step `/?vy=borja&steg=…`): the address is kept, the
 * origin is Hem.
 */
export const BOOKING_SCREEN_RETURN_PATHS = ['/bookkeeping', '/transactions', '/att-bokfora', '/'] as const
export type BookingScreenOrigin = (typeof BOOKING_SCREEN_RETURN_PATHS)[number]

/** The page a path lands on, of those the screen returns to. */
function returnPathOf(path: string): BookingScreenOrigin | null {
  // The page is the path before its query or anchor: Hem's group links (/#decide) are Hem.
  const base = path.split(/[?#]/)[0]
  if (base === '/') return '/'
  return BOOKING_SCREEN_RETURN_PATHS.find((p) => p !== '/' && (base === p || base.startsWith(`${p}/`))) ?? null
}

/**
 * A return address the screen may follow: a same-origin path, normalised by
 * safeReturnTo (dot segments resolved, protocol-relative and backslash forms
 * refused), that lands on one of the pages the screen returns to. Anything
 * else is dropped.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  const path = safeReturnTo(raw?.trim(), '')
  if (!path) return null
  return returnPathOf(path) ? path : null
}

/**
 * The page the screen was opened from, read off its return address (checked
 * by safeReturnPath): the way back is named after it and its menu row stays
 * lit. Without one, a bank row came from Bankrader and a verifikation from
 * Verifikat.
 */
export function bookingScreenOrigin(back: string | null, hasTransaction: boolean): BookingScreenOrigin {
  return (back ? returnPathOf(back) : null) ?? (hasTransaction ? '/transactions' : '/bookkeeping')
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
    if (subject.foundItemId) params.set('underlag', subject.foundItemId)
    if (subject.picked) params.set('vald', '1')
  }
  const returnTo = safeReturnPath(back)
  if (returnTo) params.set('tillbaka', returnTo)
  const qs = params.toString()
  return qs ? `${BOOKING_SCREEN_PATH}?${qs}` : BOOKING_SCREEN_PATH
}

/**
 * What the address asks to book. A transaction id or inbox item id that is
 * not a uuid, or an account that is not four digits, is dropped rather than
 * trusted: a broken link opens an empty verifikation (or the row without
 * underlag) instead of a lookup on garbage.
 */
export function parseBookingScreenSubject(query: {
  transaktion?: QueryValue
  konto?: QueryValue
  underlag?: QueryValue
  vald?: QueryValue
}): BookingScreenSubject {
  const transactionId = first(query.transaktion)
  if (!transactionId || !isUuid(transactionId)) return { kind: 'voucher' }
  const account = first(query.konto)
  const found = first(query.underlag)
  return {
    kind: 'transaction',
    transactionId: transactionId.toLowerCase(),
    account: account && ACCOUNT_NUMBER_RE.test(account) ? account : null,
    ...(found && isUuid(found) ? { foundItemId: found.toLowerCase() } : {}),
    ...(first(query.vald) === '1' ? { picked: true } : {}),
  }
}

/** The page to return to after booking, when the address names a safe one. */
export function parseBookingScreenBack(query: { tillbaka?: QueryValue }): string | null {
  return safeReturnPath(first(query.tillbaka))
}
