import 'server-only'

import { resolveBrandResultByHost } from '@/lib/branding/resolve'
import { createLogger } from '@/lib/logger'

// Which application origin an auth link (password reset, invite, email
// change, signup confirmation) may point at.
//
// The brands table is the ONLY registry of white-label hosts. Until
// 2026-09-07 this module kept a second copy in NEXT_PUBLIC_WHITELABEL_DOMAINS,
// a comma-separated env var compiled into the browser bundle so the login
// page could validate the reset callback before calling GoTrue. Every new
// brand then had to be added to the brands row, the env var, the Supabase
// redirect allowlist AND a redeploy; two partners shipped with the env var
// stale, and their reset mails went out canonical-branded to the canonical
// host. A registry that has to be remembered is a registry that drifts, so
// the copy is gone: the routes resolve the request host against the brands
// table server-side, and the browser no longer carries a domain list.
//
// The request Host header is an input, never a trust anchor. A host is used
// only when it is exactly the canonical app host, exactly one of this
// deployment's own Vercel hostnames, or exactly a registered brand domain.
// Everything else falls back to NEXT_PUBLIC_APP_URL, so a spoofed header
// can at most select another host Accounted already serves. GoTrue's own
// redirect allowlist remains the backstop behind all of this: it matches
// the FULL redirect_to including the query, with `*` stopping at `.` and
// `/`, so hosted carries `https://*.accounted.se/auth/callback**` and
// `https://*.accounted.se/invite/**` (docs/WHITELABEL.md).

const log = createLogger('trusted-app-origin')

const LOCAL_APP_ORIGIN = 'http://localhost:3000'

// Development-only hostnames. When the canonical app URL itself is local,
// any of these is the same developer machine, so a lane dev server on
// localhost:3001 keeps receiving its own auth links instead of the port
// 3000 canonical. Production never has a local canonical, so this branch
// is unreachable there.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')
}

/**
 * The brands table could not be read, so the request host cannot be
 * classified. Thrown instead of silently answering with the canonical
 * origin: for a white-label user that answer is a wrong-brand mail whose
 * recovery session lands on a foreign domain, the exact failure this
 * registry exists to prevent. The code maps to the TRANSIENT_ERROR entry
 * (503, retryable) in withRouteContext routes; anonymous routes answer 503
 * themselves, mirroring the signup gate's fail-safe branch.
 */
export class BrandLookupFailedError extends Error {
  readonly code = 'TRANSIENT_ERROR'
  readonly status = 503

  constructor(readonly host: string) {
    super(`brand lookup failed for host ${host}`)
    this.name = 'BrandLookupFailedError'
  }
}

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

/**
 * The hostnames Vercel assigns to THIS deployment (preview URL and branch
 * alias). Derived from the platform, never enumerated: a preview build
 * answering its own *.vercel.app host may send auth links back to itself,
 * which is what lets signup and reset be tested on a preview at all. Any
 * other *.vercel.app host is somebody else's deployment and stays untrusted.
 * Production deployments serve the canonical and brand hosts, which resolve
 * before this check, so it does not widen anything there.
 */
function deploymentOwnHostnames(): Set<string> {
  const hosts = new Set<string>()
  for (const value of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
    const parsed = parseHost(value)
    if (parsed && parsed.port === '') hosts.add(parsed.hostname)
  }
  return hosts
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
 * Resolve a request host (or browser origin) to an application origin.
 *
 * The canonical app host is always trusted. Any other host must be exactly
 * one of this deployment's own Vercel hostnames or exactly a registered
 * brands.domain. Wildcards, suffixes and non-default ports are never
 * accepted. Registered hosts are always upgraded to HTTPS.
 *
 * Throws BrandLookupFailedError when the brands table cannot be read, so
 * the caller refuses (503, retry) rather than sending a wrong-brand link.
 */
export async function resolveTrustedAppOrigin(
  candidate: string | null | undefined,
): Promise<string> {
  const canonicalOrigin = getCanonicalAppOrigin()
  const canonical = new URL(canonicalOrigin)
  const canonicalHostname = normalizeHostname(canonical.hostname)
  const parsed = parseHost(candidate)

  if (!parsed) return canonicalOrigin

  if (parsed.hostname === canonicalHostname && parsed.port === canonical.port) {
    return canonicalOrigin
  }

  // Local development: a local canonical trusts every local host and port
  // on the same scheme (lane servers on 3001-3003 confirm on themselves).
  if (isLocalHostname(canonicalHostname) && isLocalHostname(parsed.hostname)) {
    return `${canonical.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  }

  if (parsed.hostname === canonicalHostname) return canonicalOrigin

  // A non-default port is not a hosted domain, even when its hostname
  // matches. URL normalisation represents :443 as an empty port.
  if (parsed.port !== '') return canonicalOrigin

  if (deploymentOwnHostnames().has(parsed.hostname)) {
    return `https://${parsed.hostname}`
  }

  const { brand, lookupFailed } = await resolveBrandResultByHost(parsed.hostname)
  if (lookupFailed) {
    log.warn('brand lookup failed; refusing to build an auth link for this host', {
      host: parsed.hostname,
    })
    throw new BrandLookupFailedError(parsed.hostname)
  }
  if (!brand) return canonicalOrigin

  return `https://${normalizeHostname(brand.domain)}`
}

/**
 * The host a request was addressed to, as seen by the public edge: the
 * forwarded host set by Vercel or the reverse proxy, else the Host header.
 * request.url is deliberately not used: behind a proxy it can be an
 * internal origin, which used to yield canonical links on self-hosted
 * multi-brand installations.
 */
export function requestHost(request: Request): string | null {
  const forwarded =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  if (forwarded) return forwarded
  return parseHttpOrigin(request.url)?.host ?? null
}

/** Resolve an API request to a trusted application origin. */
export async function resolveRequestAppOrigin(request: Request): Promise<string> {
  return resolveTrustedAppOrigin(requestHost(request))
}

/**
 * Build a GoTrue password recovery callback on a registered application
 * host. Unknown hosts fall back to the canonical application URL.
 */
export async function buildPasswordResetRedirectTo(
  host: string | null | undefined,
): Promise<string> {
  return `${await resolveTrustedAppOrigin(host)}/auth/callback?next=/reset-password`
}
