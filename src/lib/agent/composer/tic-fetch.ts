import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.composer.tic-fetch')

// Live-fetch the TIC company profile and cache it on `companies.tic_snapshot`.
// Used by the agent onboarding stream (Phase A step 1) and the
// /onboarding/agent server component so the review card has SNI,
// verksamhetsbeskrivning, address, and recent financials without requiring
// the user to have visited the TIC workspace beforehand.
//
// Core never imports @/extensions/, so the profile comes from the TIC
// extension's `fetchCompanyProfile` service, resolved through the extension
// registry. It used to be an HTTP call back to this server's own /profile
// route, which needed the caller's cookie and origin, cost a second
// serverless invocation, and depended on guessing the right origin. With
// TIC disabled there is no provider and the cache is all there is.
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

/** The TIC extension's profile service (services.fetchCompanyProfile). */
export const FETCH_COMPANY_PROFILE_SERVICE = 'fetchCompanyProfile'
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
  const { supabase, companyId, upgradeV1 = false, timeoutMs = FETCH_TIMEOUT_MS } = opts

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

  const profile = await fetchTicProfile(orgNumber, timeoutMs)
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
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  // Loaded on use, not statically: the settings panel's refresh action reaches
  // this module from a client component, and a static registry import would
  // pull lib/init toward the browser build (check:guards static-init-import).
  const { extensionRegistry } = await import('@/lib/extensions/registry')
  const provider = (await extensionRegistry.getAll()).find(
    (ext) => typeof ext.services?.[FETCH_COMPANY_PROFILE_SERVICE] === 'function',
  )
  if (!provider) return null

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The Lens calls behind the profile keep running past the deadline (and
    // count against quota), exactly as an aborted HTTP fetch did; the caller
    // just stops waiting for them.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const result = await Promise.race([
      provider.services![FETCH_COMPANY_PROFILE_SERVICE](orgNumber) as Promise<Record<string, unknown> | null>,
      timeout,
    ])
    if (result === 'timeout') {
      log.warn('tic profile timed out', { timeoutMs })
      return null
    }
    return result ?? null
  } catch (err) {
    // TIC not configured, quota hit, upstream outage: a normal fallback, so
    // the caller degrades to whatever snapshot it already has.
    log.warn('tic profile fetch failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}
