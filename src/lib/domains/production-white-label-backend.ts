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
// a customer host under the namespace that nobody had added to the list. An
// allowlist of protected hosts is only as current as the last rollout that
// remembered to update it, and a denylist naming one forbidden project cannot
// see a third project at all. Stating which project is production makes both
// classes of miss unreachable.
const HOSTED_PRODUCTION_NAMESPACE = 'accounted.se'
const PRODUCTION_SUPABASE_HOST = 'pwxtzglxptnnvjrpixpg.supabase.co'

// Production hosts outside the namespace above. Such a hostname is not
// derivable from anything the deployment knows about itself, so it has to be
// classified by hand. Hosts inside the namespace are never listed: the
// namespace rule already covers them.
//
// Checked in: only Accounted's own legacy canonical host, which is live
// production today. A customer that brings its own domain
// (docs/WHITELABEL.md step 1) is classified through the
// PRODUCTION_CUSTOM_DOMAIN_HOSTS env var instead (comma-separated hostnames):
// this repository is public and a customer hostname identifies the customer.
// Set it in every hosting environment, preview included. A hosted deployment
// that lacks it fails closed, see HOSTED_VERCEL_PROJECT_ID below.
//
// This is an owner-approved production classification, not an auth callback
// registry. Do not derive it from the brands table (the registry auth links
// resolve against, lib/domains/trusted-app-origin.ts), which can also hold
// demo, pilot, or staging-only brands.
const OWN_PRODUCTION_HOSTS_OUTSIDE_NAMESPACE = new Set(['app.gnubok.se'])

// The Vercel project behind the hosted product, compared against the
// VERCEL_PROJECT_ID system variable. It is what lets a missing custom-domain
// inventory fail closed without bricking anyone else: a fork or a self-hosted
// deployment also runs its own backend on its own domain with no inventory,
// and the request alone cannot tell the two apart. On this project an absent,
// empty or malformed PRODUCTION_CUSTOM_DOMAIN_HOSTS means "inventory unknown",
// so every host that is not a preview or local name requires the production
// backend. Production itself is unaffected, it is on that backend already.
// Moving the hosted product to another Vercel project means updating this id,
// like PRODUCTION_SUPABASE_HOST above.
const HOSTED_VERCEL_PROJECT_ID = 'prj_zOvCFaOMXS166cUY5VYEGHKke00X'

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

function parseCustomDomainHosts(value: string | undefined): string[] {
  if (!value) return []

  return value.split(',').map(normalizeHostname).filter(Boolean)
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
 * What the deployment knows about itself, read from the environment by the
 * caller so each read stays a static property read.
 */
export interface WhiteLabelDeploymentEnv {
  /** Raw PRODUCTION_CUSTOM_DOMAIN_HOSTS value. */
  customDomainHosts?: string
  /** Raw VERCEL_PROJECT_ID value. */
  vercelProjectId?: string
}

/**
 * Whether a request host is customer-facing production traffic, and so may be
 * served only by the production Supabase project.
 *
 * Hosts outside the hosted namespace stay out of scope unless they are an
 * approved customer domain: a self-hosted deployment runs its own backend on
 * its own domain, and demanding Accounted's project there would brick it. The
 * one exception is the hosted project without a usable inventory, which cannot
 * rule any host out and so treats all of them as production.
 */
function requiresProductionBackend(
  requestHostname: string,
  deployment: WhiteLabelDeploymentEnv,
): boolean {
  const hostname = normalizeHostname(requestHostname)
  if (isPreviewHostname(hostname) || isLocalHostname(hostname)) return false

  if (
    isHostedNamespaceHostname(hostname) ||
    OWN_PRODUCTION_HOSTS_OUTSIDE_NAMESPACE.has(hostname)
  ) {
    return true
  }

  const customDomainHosts = parseCustomDomainHosts(deployment.customDomainHosts)
  if (customDomainHosts.length === 0) {
    return deployment.vercelProjectId === HOSTED_VERCEL_PROJECT_ID
  }

  return customDomainHosts.includes(hostname)
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
 *
 * deployment carries the raw env values, passed in by the caller like
 * supabaseUrl so each env read stays a static property read.
 */
export function usesForbiddenWhiteLabelBackend(
  requestHostname: string,
  supabaseUrl: string | undefined,
  deployment: WhiteLabelDeploymentEnv = {},
): boolean {
  if (!requiresProductionBackend(requestHostname, deployment)) {
    return false
  }

  return parseBackendHostname(supabaseUrl) !== PRODUCTION_SUPABASE_HOST
}
