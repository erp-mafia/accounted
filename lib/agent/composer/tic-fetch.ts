import type { SupabaseClient } from '@supabase/supabase-js'

// Live-fetch the TIC company profile via the existing extension HTTP route
// and cache it on `companies.tic_snapshot`. Used by the agent onboarding
// stream (Phase A step 1) and the /onboarding/agent server component so the
// review card has SNI, verksamhetsbeskrivning, address, and recent financials
// without requiring the user to have visited the TIC workspace beforehand.
//
// Why HTTP self-fetch rather than a direct import: core-build CI forbids
// `from '@/extensions/` imports in lib/agent/*. Going through the extension's
// public HTTP surface keeps the boundary intact and works the same in dev
// and on Vercel. The TIC handler already accepts cookie-auth, so we just
// forward the user's session cookie.
//
// Stale-cache policy: anything cached within the last 7 days is reused
// verbatim. TIC data is slow-changing (sniCodes, registration, address
// rarely flip) so this avoids re-hitting TIC on every page load.

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const FETCH_TIMEOUT_MS = 5_000

export interface TicSnapshotResult {
  snapshot: Record<string, unknown> | null
  source: 'cached' | 'fetched' | 'fallback'
}

export async function ensureTicSnapshot(opts: {
  supabase: SupabaseClient
  companyId: string
  cookieHeader: string
  // Origin to use for the internal self-fetch. The caller derives this from
  // the incoming request's host header so dev (localhost:3000), preview
  // (vercel.app), and production all reach their own instance of the TIC
  // route. Falls back to NEXT_PUBLIC_APP_URL when not supplied — fine for
  // background jobs but wrong for request-scoped paths because that env var
  // is the production canonical URL even in dev.
  origin?: string
}): Promise<TicSnapshotResult> {
  const { supabase, companyId, cookieHeader, origin } = opts

  const { data: companyRow } = await supabase
    .from('companies')
    .select('org_number, tic_snapshot, tic_snapshot_fetched_at')
    .eq('id', companyId)
    .single()

  if (!companyRow) return { snapshot: null, source: 'fallback' }

  // Fresh cache hit — nothing to do.
  if (companyRow.tic_snapshot && !isStale(companyRow.tic_snapshot_fetched_at as string | null)) {
    return { snapshot: companyRow.tic_snapshot as Record<string, unknown>, source: 'cached' }
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

  const profile = await fetchTicProfile(orgNumber, cookieHeader, origin)
  if (!profile) {
    // Fall through with whatever (possibly stale) snapshot we already have.
    return {
      snapshot: (companyRow.tic_snapshot as Record<string, unknown> | null) ?? null,
      source: 'fallback',
    }
  }

  // Persist. Best-effort — if the update fails, we still return the profile
  // we just fetched so the current request can use it.
  const { error } = await supabase
    .from('companies')
    .update({
      tic_snapshot: profile,
      tic_snapshot_fetched_at: new Date().toISOString(),
    })
    .eq('id', companyId)
  if (error) {
    // Silent — surfaces in dev log only. Caller doesn't care if cache write fails.
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
): Promise<Record<string, unknown> | null> {
  const baseUrl = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const url = `${baseUrl}/api/extensions/ext/tic/profile?org_number=${encodeURIComponent(orgNumber)}`

  try {
    const res = await fetch(url, {
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[tic-fetch] ${url} → ${res.status}`)
      return null
    }
    const body = (await res.json()) as { data?: Record<string, unknown> }
    return body.data ?? null
  } catch (err) {
    // Network error, timeout, TIC extension disabled, TIC API misconfigured.
    // Any of these is a normal fallback — return null so the caller can
    // degrade gracefully.
    console.warn(`[tic-fetch] ${url} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}
