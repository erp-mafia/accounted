const LOCAL_APP_ORIGIN = 'http://localhost:3000'

interface ParsedHost {
  hostname: string
  port: string
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '')
}

function parseHttpOrigin(value: string | undefined): URL | null {
  if (!value) return null

  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function parseHost(value: string | null | undefined): ParsedHost | null {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null

  try {
    const url = parseHttpOrigin(
      trimmed.includes('://') ? trimmed : `https://${trimmed}`,
    )
    if (!url) return null
    if (url.pathname !== '/' || url.search || url.hash) return null

    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port,
    }
  } catch {
    return null
  }
}

function registeredWhiteLabelHosts(): Set<string> {
  const configured = process.env.NEXT_PUBLIC_WHITELABEL_DOMAINS
  if (!configured) return new Set()

  const hosts = configured
    .split(',')
    .map((value) => parseHost(value))
    .filter((value): value is ParsedHost => value !== null && value.port === '')
    .map(({ hostname }) => hostname)

  return new Set(hosts)
}

/**
 * Return the configured canonical application origin.
 *
 * Paths, queries, and fragments in NEXT_PUBLIC_APP_URL are deliberately
 * discarded so callers cannot accidentally append auth paths below them.
 */
export function getCanonicalAppOrigin(): string {
  const configured = parseHttpOrigin(process.env.NEXT_PUBLIC_APP_URL)
  return configured?.origin ?? LOCAL_APP_ORIGIN
}

/**
 * Resolve a browser origin or request host to an application origin.
 *
 * The canonical app host is always trusted. Additional hosts must be exact
 * entries in NEXT_PUBLIC_WHITELABEL_DOMAINS. Wildcards and suffix matching are
 * intentionally unsupported: auth links may never follow an attacker-chosen
 * Host header. Registered white-label domains are always upgraded to HTTPS.
 */
export function resolveTrustedAppOrigin(candidate: string | null | undefined): string {
  const canonicalOrigin = getCanonicalAppOrigin()
  const canonical = new URL(canonicalOrigin)
  const parsed = parseHost(candidate)

  if (!parsed) return canonicalOrigin

  if (parsed.hostname === normalizeHostname(canonical.hostname)) {
    return canonicalOrigin
  }

  if (!registeredWhiteLabelHosts().has(parsed.hostname)) {
    return canonicalOrigin
  }

  // A non-default port is not a registered hosted domain, even when its
  // hostname matches. URL normalisation represents :443 as an empty port.
  if (parsed.port !== '') return canonicalOrigin

  return `https://${parsed.hostname}`
}

/** Resolve an API request to a trusted application origin. */
export function resolveRequestAppOrigin(request: Request): string {
  const requestOrigin = parseHttpOrigin(request.url)?.origin
  return resolveTrustedAppOrigin(requestOrigin)
}

/**
 * Build a GoTrue password recovery callback on a registered application host.
 * Unknown browser origins fall back to the canonical application URL.
 */
export function buildPasswordResetRedirectTo(browserOrigin: string): string {
  return `${resolveTrustedAppOrigin(browserOrigin)}/auth/callback?next=/reset-password`
}
