/**
 * Browser-side Supabase auth cookie hygiene.
 *
 * Why this exists: when a browser holds two cookies with the same auth
 * cookie name (same name, different Path or Domain attribute), the two sides
 * of @supabase/ssr read different ones. The server (Next's cookie parser)
 * keeps the LAST occurrence in the Cookie header, the browser client (the
 * `cookie` package over document.cookie) keeps the FIRST. The server then
 * sees a live session and renders the dashboard, while every direct browser
 * read goes out with a stale or unusable token, falls back to the anon key,
 * and RLS answers with empty lists. Signing out through supabase-js only
 * expires the Path=/ host-only variant, so "log out and in again" leaves the
 * stray duplicate behind and the problem survives; a private window works
 * because it starts without it.
 *
 * The helpers here find the auth cookies and build the expiry strings that
 * remove every variant the browser can hold for the current page, whatever
 * Path or Domain it was written with.
 */

const AUTH_COOKIE_PREFIX = 'sb-'

/** Names of Supabase auth cookies in a document.cookie string, in order, duplicates kept. */
export function authCookieNames(cookieString: string): string[] {
  const names: string[] = []
  for (const pair of cookieString.split(/;\s*/)) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim()
    if (name.startsWith(AUTH_COOKIE_PREFIX)) names.push(name)
  }
  return names
}

/** Auth cookie names that occur more than once: the state the two parsers disagree on. */
export function duplicateAuthCookieNames(cookieString: string): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const name of authCookieNames(cookieString)) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return [...duplicates]
}

/**
 * Every Path the browser could have scoped a cookie to that is visible on
 * `pathname`: "/" and each ancestor of the current path.
 */
function candidatePaths(pathname: string): string[] {
  const paths = ['/']
  const segments = pathname.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    paths.push(current)
  }
  return paths
}

/**
 * Every Domain attribute a cookie visible on `hostname` could carry: none
 * (host-only), the host itself, and each parent domain above the public
 * suffix's last label. An IP address or single-label host only has host-only.
 */
function candidateDomains(hostname: string): Array<string | null> {
  const domains: Array<string | null> = [null]
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return domains
  const labels = hostname.split('.')
  if (labels.length < 2) return domains
  for (let i = 0; i <= labels.length - 2; i++) {
    domains.push(labels.slice(i).join('.'))
  }
  return domains
}

/**
 * document.cookie assignments that expire `name` under every Path and Domain
 * combination visible on this page. Assigning a combination that does not
 * exist is a no-op in every browser.
 */
export function cookieExpiryVariants(
  name: string,
  hostname: string,
  pathname: string,
): string[] {
  const variants: string[] = []
  for (const path of candidatePaths(pathname)) {
    for (const domain of candidateDomains(hostname)) {
      variants.push(
        `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${path}` +
          (domain ? `; Domain=${domain}` : ''),
      )
    }
  }
  return variants
}

type CookieDocument = { cookie: string }
type CookieLocation = { hostname: string; pathname: string }

/**
 * Expire every Supabase auth cookie variant the page can see. Returns how
 * many distinct auth cookie names were scrubbed.
 */
export function scrubAuthCookies(doc: CookieDocument, loc: CookieLocation): number {
  const names = [...new Set(authCookieNames(doc.cookie))]
  for (const name of names) {
    for (const variant of cookieExpiryVariants(name, loc.hostname, loc.pathname)) {
      doc.cookie = variant
    }
  }
  return names.length
}
