/**
 * Canonical base URL for v1 surfaces.
 *
 * Use this, NOT `new URL(request.url).host`, when assembling URLs that go
 * into discovery files, OpenAPI specs, or any response a 3rd-party agent
 * caches. The inbound `Host` header is attacker-controlled at the edge; a
 * spoofed value would otherwise poison agent discovery and redirect them
 * to attacker-controlled endpoints.
 *
 * Honours `NEXT_PUBLIC_APP_URL` (the same env var the rest of the codebase
 * uses for absolute links). Falls back to `https://localhost:3000` for
 * local development when the env var is unset: this is a deliberate
 * fail-closed default that any production deploy will override.
 */

export function getCanonicalBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return 'http://localhost:3000'
}

/**
 * Base URL for the OAuth/MCP discovery documents (/.well-known/*).
 *
 * The app is served on two domains since the accounted.se cutover:
 * app.accounted.se for humans and app.gnubok.se for machine traffic
 * (existing MCP connectors and API clients were configured against the
 * legacy host and it can never be retired). RFC 8414/9728 clients validate
 * that the metadata they fetch is self-consistent with the host they
 * fetched it from, so discovery must reflect the host the client actually
 * used. The Host header stays attacker-controlled at the edge, so only
 * allowlisted hosts are reflected; anything else falls back to the
 * canonical base URL.
 */
const LEGACY_DISCOVERY_HOSTS = new Set(['app.gnubok.se'])

export function resolveDiscoveryBaseUrl(request: Request): string {
  const canonical = getCanonicalBaseUrl()
  const host = request.headers.get('host')?.trim().toLowerCase()
  if (!host) return canonical

  let canonicalHost: string | null = null
  try {
    canonicalHost = new URL(canonical).host.toLowerCase()
  } catch {
    canonicalHost = null
  }

  if (host === canonicalHost) return canonical
  if (LEGACY_DISCOVERY_HOSTS.has(host)) return `https://${host}`
  // Exact hostname match: a prefix check would reflect spoofed hosts like
  // localhost.evil.example into the discovery documents.
  const hostname = host.replace(/:\d+$/, '')
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `http://${host}`
  }
  return canonical
}
