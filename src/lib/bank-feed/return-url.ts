/**
 * Where the person comes back after signing a bank consent on the bank's own
 * page (the redirect method): the entry point they started from, on the app
 * origin, with the connection named. Connect hands the bank that URL as the
 * return; the bank sends the browser back to it with `state` (the same
 * connection id), `result` (ok or error) and `code` (the bank's failure code)
 * added, and the page turns that into the Koppla banken flow at its BankID
 * step. The URL carries only the connection id and a result flag, never the
 * outcome itself: the truth comes from polling the authorisation.
 *
 * Isomorphic on purpose: the browser reads the param names, the service
 * builds the URL. Nothing here may import a server-only module.
 */

/** The query parameter that names the connection on the return (and on the second signatory's reminder link). */
export const BANK_CONNECT_RETURN_PARAM = 'bank_connect'

/** The entry points of Koppla banken, each its own page to come back to. */
export const BANK_CONNECT_RETURN_SURFACES = ['connections', 'banking', 'onboarding'] as const
export type BankConnectReturnSurface = (typeof BANK_CONNECT_RETURN_SURFACES)[number]

/** The page of each entry point; an allowlist, so a body can never name another target. */
const SURFACE_PATHS: Readonly<Record<BankConnectReturnSurface, string>> = {
  connections: '/settings/connections',
  banking: '/settings/banking',
  onboarding: '/onboarding/books?station=bank',
}

export function isBankConnectReturnSurface(value: unknown): value is BankConnectReturnSurface {
  return typeof value === 'string' && (BANK_CONNECT_RETURN_SURFACES as readonly string[]).includes(value)
}

/**
 * The signatory page (app/koppla/[token]): a firmatecknare without a login
 * comes back to their own link, so this target's page is built from the
 * link's token and is reachable only from the token routes, never from a
 * session body (the session routes accept the allowlist above alone).
 */
export const BANK_CONNECT_SIGNATORY_TARGET = 'koppla' as const
export type BankConnectReturnTarget = BankConnectReturnSurface | typeof BANK_CONNECT_SIGNATORY_TARGET

/** The return URL for a connection: the target's page on `origin` with the connection named; the signatory page needs the link's token. */
export function bankConnectReturnUrl(origin: string, surface: BankConnectReturnTarget, connectionId: string, options: { token?: string | null } = {}): string {
  let url: URL
  if (surface === BANK_CONNECT_SIGNATORY_TARGET) {
    if (!options.token) throw new Error('The signatory return needs the link token')
    url = new URL(`/koppla/${encodeURIComponent(options.token)}`, origin)
  } else {
    url = new URL(SURFACE_PATHS[surface], origin)
  }
  url.searchParams.set(BANK_CONNECT_RETURN_PARAM, connectionId)
  return url.toString()
}
