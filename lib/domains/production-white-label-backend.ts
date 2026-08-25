// This is an owner-approved production classification, not an auth callback
// allowlist. Do not derive it from NEXT_PUBLIC_WHITELABEL_DOMAINS, which can
// also contain demo, pilot, or self-hosted domains.
const CUSTOMER_PRODUCTION_WHITE_LABEL_HOSTS = new Set([
  'acount.accounted.se',
  'arbore.accounted.se',
  'elma.accounted.se',
  'm360.accounted.se',
  'redovisningskompaniet.accounted.se',
  'willem.accounted.se',
  'ziffr.accounted.se',
])

const FORBIDDEN_STAGING_SUPABASE_HOST =
  'metjnjrhvujscngnpzdv.supabase.co'

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

/**
 * Block Accounted's customer-facing white-label hosts from using the staging
 * Supabase project. The request host and backend host are exact matches: this
 * is an environment safety boundary, not suffix-based domain authorization.
 */
export function usesForbiddenWhiteLabelBackend(
  requestHostname: string,
  supabaseUrl: string | undefined,
): boolean {
  const hostname = normalizeHostname(requestHostname)
  if (!CUSTOMER_PRODUCTION_WHITE_LABEL_HOSTS.has(hostname)) return false

  return parseBackendHostname(supabaseUrl) === FORBIDDEN_STAGING_SUPABASE_HOST
}
