/**
 * A bank's redirect return through the canonical origin.
 *
 * Connect accepts one return origin per connector key: the instance it is
 * registered for (hosted: the canonical app origin). A person on another
 * origin Accounted serves, such as a white-label brand host, signs there and
 * must come back there, where their session lives. So the return Connect is
 * given is a hop on the canonical origin naming the real target, and
 * GET /api/bank/return forwards the browser to it with the bank's
 * parameters (state, result, code), once the target is a trusted app origin
 * and one of the signing pages below.
 *
 * Isomorphic on purpose: the services build the hop, the route checks it.
 * Nothing here may import a server-only module.
 */

/** The hop on the canonical origin (app/api/bank/return/route.ts). */
export const RETURN_BOUNCE_PATH = '/api/bank/return'

/** The query parameter that names the real return on the hop. */
export const RETURN_BOUNCE_TARGET_PARAM = 'to'

/** The pages a bank's return may land on: the Koppla banken entry points and Betalningar. */
const BOUNCE_TARGET_PATHS: readonly string[] = ['/settings/connections', '/settings/banking', '/onboarding/books', '/payments']

/** The signatory pages, one token segment each: /koppla/<token> (bank consent) and /betala/<token> (payments). */
const BOUNCE_TARGET_TOKEN_PREFIXES: readonly string[] = ['/koppla/', '/betala/']

/** Whether a return may land on this path: an allowlist, so the hop can only ever finish a signing. */
export function isReturnBounceTarget(pathname: string): boolean {
  if (BOUNCE_TARGET_PATHS.includes(pathname)) return true
  return BOUNCE_TARGET_TOKEN_PREFIXES.some((prefix) => {
    if (!pathname.startsWith(prefix)) return false
    const token = pathname.slice(prefix.length)
    return token.length > 0 && !token.includes('/')
  })
}

/** `target` as Connect may take it: unchanged on the canonical origin, else the hop on the canonical origin that forwards to it. */
export function viaCanonicalOrigin(target: string, canonicalOrigin: string): string {
  const url = new URL(target)
  const canonical = new URL(canonicalOrigin).origin
  if (url.origin === canonical) return url.toString()
  const hop = new URL(RETURN_BOUNCE_PATH, canonical)
  hop.searchParams.set(RETURN_BOUNCE_TARGET_PARAM, url.toString())
  return hop.toString()
}
