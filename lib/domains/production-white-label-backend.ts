// Accounted's hosted production identity, as checked-in configuration.
//
// HOSTED_PRODUCTION_NAMESPACE is the DNS zone the hosted product serves its
// customers from: app.accounted.se plus one <brand>.accounted.se host per
// white-label byra. PRODUCTION_SUPABASE_HOST is the only Supabase project
// those hosts may ever be served by.
//
// The guard asserts the backend instead of enumerating the hosts to protect.
// The first version did the opposite: it listed seven approved hostnames and
// compared the backend against the staging project by name. It then failed
// open on 2026-08-26, when a feature-branch preview wired to staging answered
// improveone.accounted.se, a customer host nobody had added to the list. An
// allowlist of protected hosts is only as current as the last rollout that
// remembered to update it, and a denylist naming one forbidden project cannot
// see a third project at all. Stating which project is production makes both
// classes of miss unreachable.
const HOSTED_PRODUCTION_NAMESPACE = 'accounted.se'
const PRODUCTION_SUPABASE_HOST = 'pwxtzglxptnnvjrpixpg.supabase.co'

// The approved customer-facing production hosts. Almost all of them already
// sit inside the namespace above, so this set is documentation first: it is
// the checked-in inventory the test suite pins host by host, and it is the
// only place a host outside the namespace can be classified, since such a
// hostname is not derivable from anything the deployment knows about itself.
// That covers Accounted's own legacy canonical host app.gnubok.se, which is
// live production today, and a customer that brings its own domain
// (docs/WHITELABEL.md step 1).
//
// This is an owner-approved production classification, not an auth callback
// allowlist. Do not derive it from NEXT_PUBLIC_WHITELABEL_DOMAINS, which can
// also contain demo, pilot, or self-hosted domains.
const CUSTOMER_PRODUCTION_WHITE_LABEL_HOSTS = new Set([
  'acount.accounted.se',
  'amnas.accounted.se',
  'app.gnubok.se',
  'arbore.accounted.se',
  'elma.accounted.se',
  'improveone.accounted.se',
  'm360.accounted.se',
  'redovisningskompaniet.accounted.se',
  'willem.accounted.se',
  'ziffr.accounted.se',
])

// Hosts that are never customer-facing: Vercel's per-deployment preview
// domains, and local or throwaway development names. Everything else inside
// the hosted namespace counts as production traffic, so a newly added brand
// host is protected by default rather than by being remembered. A host inside
// the namespace that is deliberately non-production has to be excluded here
// explicitly, in the same change that creates it.
const PREVIEW_HOST_SUFFIX = '.vercel.app'
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.test']

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

function parseBackendHostname(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null

  try {
    return normalizeHostname(new URL(supabaseUrl).hostname)
  } catch {
    return null
  }
}

function isPreviewHostname(hostname: string): boolean {
  return hostname.endsWith(PREVIEW_HOST_SUFFIX)
}

function isLocalHostname(hostname: string): boolean {
  return (
    LOCAL_HOSTNAMES.has(hostname) ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  )
}

function isHostedNamespaceHostname(hostname: string): boolean {
  return (
    hostname === HOSTED_PRODUCTION_NAMESPACE ||
    hostname.endsWith(`.${HOSTED_PRODUCTION_NAMESPACE}`)
  )
}

/**
 * Whether a request host is customer-facing production traffic, and so may be
 * served only by the production Supabase project.
 *
 * Hosts outside the hosted namespace stay out of scope unless they are an
 * approved customer domain: a self-hosted deployment runs its own backend on
 * its own domain, and demanding Accounted's project there would brick it.
 */
function requiresProductionBackend(requestHostname: string): boolean {
  const hostname = normalizeHostname(requestHostname)
  if (isPreviewHostname(hostname) || isLocalHostname(hostname)) return false

  return (
    isHostedNamespaceHostname(hostname) ||
    CUSTOMER_PRODUCTION_WHITE_LABEL_HOSTS.has(hostname)
  )
}

/**
 * Block Accounted's customer-facing production hosts from any backend that is
 * not the production Supabase project. The backend host is an exact match:
 * this is an environment safety boundary, not suffix-based domain
 * authorization.
 *
 * A missing, empty or unparseable backend URL counts as not production. Such a
 * build cannot serve a customer host either way: it would otherwise reach
 * updateSession and throw straight out of the Web Handler on every path.
 */
export function usesForbiddenWhiteLabelBackend(
  requestHostname: string,
  supabaseUrl: string | undefined,
): boolean {
  if (!requiresProductionBackend(requestHostname)) return false

  return parseBackendHostname(supabaseUrl) !== PRODUCTION_SUPABASE_HOST
}
