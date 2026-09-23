import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.composer.tic-fetch')

// Live-fetch the TIC company profile via the existing extension HTTP route
// and cache it on `companies.tic_snapshot`. Used by the agent onboarding
// stream (Phase A step 1) and the /onboarding/agent server component so the
// review card has SNI, verksamhetsbeskrivning, address, and recent financials
// without requiring the user to have visited the TIC workspace beforehand.
//
// Why HTTP self-fetch rather than a direct import: core-build CI forbids
// imports from @/extensions/ in lib/agent/*. Going through the extension's
// public HTTP surface keeps the boundary intact and works the same in dev
// and on Vercel. The TIC handler already accepts cookie-auth, so we just
// forward the user's session cookie.
//
// Stale-cache policy: anything cached within the last 7 days is reused
// verbatim. TIC data is slow-changing (sniCodes, registration, address
// rarely flip) so this avoids re-hitting TIC on every page load.
//
// Rate budget: the /profile endpoint fans out to ~13 TIC (Lens) calls and
// the account has a ~3000/mo ceiling. So we DON'T eagerly re-fetch every
// pre-v2 (v1) snapshot: that would blow the budget across the customer
// base. Instead, v1 snapshots upgrade to v2 lazily: only when a caller
// that actually consumes the v2 sections passes `upgradeV1: true` (today
// just the agent-onboarding paths, a deliberate once-per-company action).

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
// Default fetch timeout. The agent-onboarding callers override with a longer
// budget (10s) since the user is on a wait-screen with visible progress and
// the prior 5s default killed every signup-time fetch in May (~530 wasted
// upstream Lens calls: the abort fired client-side but the upstream calls
// kept running and counted against quota). Other callers (background jobs,
// dev tooling) stay on the conservative default.
const FETCH_TIMEOUT_MS = 5_000

export interface TicSnapshotResult {
  snapshot: Record<string, unknown> | null
  source: 'cached' | 'fetched' | 'fallback'
}

// A snapshot written before the TIC v2 migration lacks the v2-only
// `statuses` section. v2 always includes the key (possibly an empty
// array), so its absence is a reliable "this is a v1 snapshot" signal.
function isV1Snapshot(snapshot: Record<string, unknown> | null): boolean {
  return snapshot != null && !('statuses' in snapshot)
}

export async function ensureTicSnapshot(opts: {
  supabase: SupabaseClient
  companyId: string
  cookieHeader: string
  // Origin to use for the internal self-fetch. The caller derives this from
  // the incoming request's host header so dev (localhost:3000), preview
  // (vercel.app), and production all reach their own instance of the TIC
  // route. Falls back to NEXT_PUBLIC_APP_URL when not supplied: fine for
  // background jobs but wrong for request-scoped paths because that env var
  // is the production canonical URL even in dev.
  origin?: string
  // When true, a cached snapshot still inside the 7-day window is
  // re-fetched if it's a pre-v2 (v1) shape. Gated to deliberate, bounded
  // callers (agent onboarding) so the v1→v2 upgrade doesn't fan out across
  // every company and exhaust the monthly TIC budget.
  upgradeV1?: boolean
  // Override the default 5s fetch timeout. Use when the caller has a UI
  // affordance for waiting (agent onboarding wait-screen) so legitimate
  // fetches don't get aborted before the ~13-call Lens fan-out completes:
  // which was the root cause of the May 2026 quota-burn incident.
  timeoutMs?: number
}): Promise<TicSnapshotResult> {
  const {
    supabase,
    companyId,
    cookieHeader,
    origin,
    upgradeV1 = false,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = opts

  const { data: companyRow } = await supabase
    .from('companies')
    .select('org_number, tic_snapshot, tic_snapshot_fetched_at')
    .eq('id', companyId)
    .single()

  if (!companyRow) return { snapshot: null, source: 'fallback' }

  const cachedSnapshot = companyRow.tic_snapshot as Record<string, unknown> | null
  const needsV2Upgrade = upgradeV1 && isV1Snapshot(cachedSnapshot)

  // Fresh cache hit: nothing to do. (Unless the caller needs v2 fields and
  // the cache is still v1, in which case we fall through to a refetch.)
  if (
    cachedSnapshot &&
    !isStale(companyRow.tic_snapshot_fetched_at as string | null) &&
    !needsV2Upgrade
  ) {
    return { snapshot: cachedSnapshot, source: 'cached' }
  }

  // Org number drifts: some onboarding flows persist it on company_settings
  // only (TicWorkspace reads from there). Prefer companies.org_number but
  // fall back to company_settings.org_number so existing companies aren't
  // permanently blocked from TIC enrichment.
  let orgNumber = (companyRow.org_number as string | null) ?? null
  if (!orgNumber) {
    const { data: settingsRow } = await supabase
      .from('company_settings')
      .select('org_number')
      .eq('company_id', companyId)
      .maybeSingle()
    orgNumber = (settingsRow?.org_number as string | null) ?? null
  }
  if (!orgNumber) {
    return { snapshot: (companyRow.tic_snapshot as Record<string, unknown> | null) ?? null, source: 'fallback' }
  }

  const profile = await fetchTicProfile(orgNumber, cookieHeader, origin, timeoutMs)
  if (!profile) {
    // Fall through with whatever (possibly stale) snapshot we already have.
    return {
      snapshot: (companyRow.tic_snapshot as Record<string, unknown> | null) ?? null,
      source: 'fallback',
    }
  }

  // Persist. Best-effort: if the update fails, we still return the profile
  // we just fetched so the current request can use it.
  const { error } = await supabase
    .from('companies')
    .update({
      tic_snapshot: profile,
      tic_snapshot_fetched_at: new Date().toISOString(),
    })
    .eq('id', companyId)
  if (error) {
    // Stale data is fine for the current request, but a silent write
    // failure means the next caller re-fetches TIC unnecessarily and the
    // monthly TIC budget bleeds. Surface it via the structured logger.
    log.warn('tic snapshot persist failed', { error: error.message, companyId })
  }

  return { snapshot: profile, source: 'fetched' }
}

function isStale(fetchedAt: string | null): boolean {
  if (!fetchedAt) return true
  const ts = Date.parse(fetchedAt)
  if (Number.isNaN(ts)) return true
  return Date.now() - ts > STALE_AFTER_MS
}

async function fetchTicProfile(
  orgNumber: string,
  cookieHeader: string,
  origin: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const baseUrl = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const url = `${baseUrl}/api/extensions/ext/tic/profile?org_number=${encodeURIComponent(orgNumber)}`

  try {
    const res = await fetch(url, {
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      log.warn('tic profile non-ok', { url, status: res.status })
      return null
    }
    const body = (await res.json()) as { data?: Record<string, unknown> }
    return body.data ?? null
  } catch (err) {
    // Network error, timeout, TIC extension disabled, TIC API misconfigured.
    // Any of these is a normal fallback: return null so the caller can
    // degrade gracefully.
    log.warn('tic profile fetch failed', {
      url,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
