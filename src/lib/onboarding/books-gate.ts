/**
 * The first-session books gate (issue #2438).
 *
 * After the journey creates a company, the dashboard is withheld until the
 * user has walked act two (/onboarding/books: source pick + import, bank,
 * Skatteverket) or deliberately skipped it. The gate is a cookie carrying
 * the company id: middleware redirects dashboard paths to the books act
 * while it matches the active company, and the exit route clears it. No
 * database column: the cookie's own lifetime IS the "first session" scope,
 * and a user who returns tomorrow is never trapped by a stale flag.
 *
 * Off switch: NEXT_PUBLIC_ONBOARDING_BOOKS_GATE_OFF=true (never set the
 * cookie, middleware ignores an existing one). On by default so the act is
 * live the moment it ships; the flag exists for rollback, not launch.
 */

import { flagEnabled } from '@/lib/env/public-flags'

export const BOOKS_GATE_COOKIE = 'gnubok-books-gate'
export const BOOKS_GATE_MAX_AGE_SECONDS = 60 * 60 * 24
export const BOOKS_PATH = '/onboarding/books'

export function booksGateEnabled(): boolean {
  return !flagEnabled(process.env.NEXT_PUBLIC_ONBOARDING_BOOKS_GATE_OFF)
}

/**
 * Paths the gate never intercepts. The books act itself, everything under
 * /api (the wizards talk to it), auth and account escape hatches, and the
 * two OAuth landing pages whose query strings the gate rewrites instead.
 */
const PASS_PREFIXES = [
  BOOKS_PATH,
  '/onboarding',
  '/select-company',
  '/settings/account',
  '/api/',
  '/auth/',
  '/login',
  '/mfa',
  '/paused',
  '/docs',
  '/invite',
  '/_next/',
]

/** Where an off-site round trip lands today, and which act-two station owns it. */
const LANDINGS: { prefix: string; station: 'bank' | 'books' }[] = [
  { prefix: '/settings/banking', station: 'bank' },
  { prefix: '/import', station: 'books' },
]

export type BooksGateDecision =
  | { action: 'pass' }
  | { action: 'redirect'; to: string }

/**
 * Decide what the gate does with a request. Pure: middleware passes the
 * pathname, search string and the cookie/company pair, and gets back a
 * verdict it can turn into a response. Query strings on the OAuth landing
 * pages travel with the redirect so the station can read bank_connected,
 * migration=error and friends exactly as the original page would have.
 */
export function decideBooksGate(input: {
  pathname: string
  search: string
  cookieCompanyId: string | null | undefined
  activeCompanyId: string | null | undefined
  enabled?: boolean
}): BooksGateDecision {
  const enabled = input.enabled ?? booksGateEnabled()
  if (!enabled) return { action: 'pass' }
  if (!input.cookieCompanyId || !input.activeCompanyId) return { action: 'pass' }
  if (input.cookieCompanyId !== input.activeCompanyId) return { action: 'pass' }
  if (PASS_PREFIXES.some((p) => input.pathname.startsWith(p))) return { action: 'pass' }

  const landing = LANDINGS.find((l) => input.pathname.startsWith(l.prefix))
  if (landing) {
    const params = new URLSearchParams(input.search)
    params.set('station', landing.station)
    return { action: 'redirect', to: `${BOOKS_PATH}?${params.toString()}` }
  }
  return { action: 'redirect', to: BOOKS_PATH }
}
