/**
 * Fail closed on a configured outbound base URL that is not https.
 *
 * Integration base URLs come from env so an operator can point a client at a
 * provider's test or production host. The requests built on them carry
 * credentials (OAuth client secrets, API gateway keys, bearer tokens, signed
 * client assertions) and filings, so an http:// value would send all of that
 * in plaintext. This throws instead, and never upgrades the scheme silently:
 * a typo should be loud, not quietly rewritten.
 *
 * Call it where the request URL is built, not at module load, so a bad env
 * fails that request and never the build or an unrelated import.
 *
 * The one plaintext exception is a loopback mock (exactly localhost or
 * 127.0.0.1) while NODE_ENV is test or development, so unit tests and a local
 * dev server can run against a fake upstream. A production build refuses it.
 *
 * Returns the input unchanged so it can wrap the value inline.
 */
export function requireHttpsUrl(raw: string, name: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // The value itself stays out of the message: a URL can carry userinfo.
    throw new Error(`${name} is not a valid URL`)
  }
  if (url.protocol === 'https:') return raw
  if (url.protocol === 'http:' && isLoopback(url.hostname) && isTestOrDevelopment()) return raw
  throw new Error(
    `${name} must be https: credentials ride in these requests ` +
      '(http is accepted only for localhost or 127.0.0.1 when NODE_ENV is test or development)',
  )
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function isTestOrDevelopment(): boolean {
  const env = process.env.NODE_ENV
  return env === 'test' || env === 'development'
}
