import { resolveTrustedAppOrigin } from '@/lib/domains/trusted-app-origin'
import { createLogger } from '@/lib/logger'

const log = createLogger('discovery-base-url')

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
 * hosts this deployment serves are reflected (this set, local development
 * and the registered brand domains, see resolveDiscoveryBaseUrl); anything
 * else falls back to the canonical base URL.
 */
const LEGACY_DISCOVERY_HOSTS = new Set(['app.gnubok.se'])

/**
 * Guards LEGACY_DISCOVERY_HOSTS against drifting from the registered OAuth
 * configuration (issue #1093). Two invariants, checked both ways:
 *
 * (a) When `NEXT_PUBLIC_SKV_OAUTH_BASE_URL` (the redirect_uri host
 *     registered with Skatteverket in Utvecklarportalen) is set, its host
 *     must be reflectable by discovery: either the canonical app host or a
 *     member of LEGACY_DISCOVERY_HOSTS. Otherwise MCP clients that
 *     re-authenticate through the pinned host receive an issuer that does
 *     not match, and AGI/moms staging fails silently.
 *
 * (b) Every member of LEGACY_DISCOVERY_HOSTS must be accounted for by the
 *     known registered configuration: the SKV OAuth pin host or the
 *     canonical app host. An orphan entry means someone added or kept a
 *     host that nothing registered actually uses.
 *
 * Returns human-readable violations; an empty array means the allowlist and
 * the registered configuration agree. Called only from
 * `__tests__/legacy-discovery-hosts.test.ts` (which pins the production
 * registration), so drift is caught in CI instead of during a production
 * re-auth near a filing deadline. No runtime behavior depends on it.
 */
export function validateLegacyDiscoveryHosts(): string[] {
  const violations: string[] = []

  let canonicalHost: string | null = null
  try {
    canonicalHost = new URL(getCanonicalBaseUrl()).host.toLowerCase()
  } catch {
    violations.push(
      `NEXT_PUBLIC_APP_URL is not a parseable URL: "${process.env.NEXT_PUBLIC_APP_URL}"`,
    )
  }

  const skvBase = process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL?.trim()
  let skvHost: string | null = null
  if (skvBase) {
    try {
      skvHost = new URL(skvBase).host.toLowerCase()
    } catch {
      violations.push(`NEXT_PUBLIC_SKV_OAUTH_BASE_URL is not a parseable URL: "${skvBase}"`)
    }
  }

  if (skvHost && skvHost !== canonicalHost && !LEGACY_DISCOVERY_HOSTS.has(skvHost)) {
    violations.push(
      `NEXT_PUBLIC_SKV_OAUTH_BASE_URL host "${skvHost}" is neither the canonical host ` +
        `("${canonicalHost}") nor in LEGACY_DISCOVERY_HOSTS; discovery would hand ` +
        `re-authenticating clients a mismatched issuer`,
    )
  }

  for (const legacyHost of LEGACY_DISCOVERY_HOSTS) {
    if (legacyHost !== canonicalHost && legacyHost !== skvHost) {
      violations.push(
        `LEGACY_DISCOVERY_HOSTS entry "${legacyHost}" matches neither the canonical host ` +
          `("${canonicalHost}") nor the NEXT_PUBLIC_SKV_OAUTH_BASE_URL host ` +
          `("${skvHost ?? 'unset'}"); it is orphaned from the registered configuration`,
      )
    }
  }

  return violations
}

/**
 * The base URL that the discovery documents, the MCP 401 challenge and the
 * RFC 9207 `iss` parameter name for this request: the host the client used,
 * when this deployment serves it.
 *
 * White-label byrå domains are served by the same deployment, and Settings
 * > API och MCP hands their users a connector URL on that domain. Their
 * registry is the brands table, read through resolveTrustedAppOrigin: the
 * same check that decides which host an auth link may point at. Without it
 * every brand domain advertised the canonical host, and MCP clients refuse
 * a resource or issuer that does not match the URL they were given (RFC
 * 9728 §3.3, RFC 8414 §3.3), so sign-in could not complete there.
 *
 * A brands lookup that fails, or throws, answers canonical: the answer an
 * unknown host gets anyway. Discovery only names a host and nothing travels
 * in it, and a 5xx in the middle of a connector setup fails the sign-in the
 * same way. A failed lookup is not cached, so the next attempt retries.
 */
export async function resolveDiscoveryBaseUrl(request: Request): Promise<string> {
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
  try {
    return await resolveTrustedAppOrigin(host, { onLookupFailure: 'canonical' })
  } catch (err) {
    log.warn('brand lookup threw; discovery falls back to the canonical host', {
      host,
      error: err instanceof Error ? err.message : String(err),
    })
    return canonical
  }
}

/**
 * The authorization server the protected-resource document names, given the
 * discovery base URL resolveDiscoveryBaseUrl returned for the request.
 *
 * The canonical host and the brand domains serve their own login page, so
 * they name themselves. A legacy host does not: its login page forwards to
 * the canonical host, so a sign-in started there finishes on the canonical
 * host, whose RFC 9207 `iss` then differs from the legacy issuer the client
 * discovered, and the client refuses the response. A legacy host therefore
 * names the canonical authorization server (RFC 9728 lets the resource and
 * its authorization server live on different hosts), while its own
 * authorization-server metadata stays in place for clients that already
 * hold it.
 */
export function authorizationServerForDiscoveryBase(discoveryBaseUrl: string): string {
  try {
    if (LEGACY_DISCOVERY_HOSTS.has(new URL(discoveryBaseUrl).host.toLowerCase())) {
      return getCanonicalBaseUrl()
    }
  } catch {
    // An unparseable base is returned as it is, like any other host.
  }
  return discoveryBaseUrl
}
