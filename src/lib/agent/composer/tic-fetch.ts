import type { SupabaseClient } from '@supabase/supabase-js'
import { sameRegistration } from '@/lib/invariants/org-number'
import { createLogger } from '@/lib/logger'
import type { TicCallPurpose } from '@/lib/tic-budget/budget'

const log = createLogger('agent.composer.tic-fetch')

// Live-fetch the TIC company profile and cache it on `companies.tic_snapshot`,
// so its readers (the company's own refresh in lib/company/tic-refresh.ts, the
// closed-year reopen) have SNI, verksamhetsbeskrivning, address, and recent
// financials without requiring the user to have visited the TIC workspace
// beforehand.
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
// rarely flip) so this avoids re-hitting TIC on every page load. A snapshot
// with incomplete sections (a detail call failed) is reused for an hour, and
// a refetch keeps the last answered value of the sections it cannot fill
// (never the annual report list: see keepLastKnownSections).
//
// Rate budget: the /profile endpoint fans out to ~13 TIC (Lens) calls and
// the account has a ~3000/mo ceiling. So we DON'T eagerly re-fetch every
// pre-v2 (v1) snapshot: that would blow the budget across the customer
// base. Instead, v1 snapshots upgrade to v2 lazily: only when a caller
// that actually consumes the v2 sections passes `upgradeV1: true` (no caller
// does today: the assistant's build did, and it is removed).

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// A snapshot some detail calls could not fill (its `incompleteSections`) is
// asked again after an hour instead of a week. A retry while the budget is
// spent costs nothing (a refused reservation is not counted), and once it is
// back the calls that did answer come from the 24 h shared response cache, so
// a retry pays only for the sections that were missing.
const INCOMPLETE_RETRY_AFTER_MS = 60 * 60 * 1000 // 1 hour

/** The TIC extension's profile service (services.fetchCompanyProfile). */
export const FETCH_COMPANY_PROFILE_SERVICE = 'fetchCompanyProfile'
// Default fetch timeout. Callers with a person waiting override with a longer
// budget (10s) since the user is watching visible progress and
// the prior 5s default killed every signup-time fetch in May (~530 wasted
// upstream Lens calls: the abort fired client-side but the upstream calls
// kept running and counted against quota). Other callers (background jobs,
// dev tooling) stay on the conservative default.
const FETCH_TIMEOUT_MS = 5_000

export interface TicSnapshotResult {
  snapshot: Record<string, unknown> | null
  source: 'cached' | 'fetched' | 'fallback'
  /**
   * Why a fallback has no fresh profile: TIC has no company under the number
   * ('not_found'), or it could not be asked ('unavailable': TIC off, budget
   * spent, timeout, upstream error, no org number).
   */
  reason?: 'not_found' | 'unavailable'
}

// A snapshot written before the TIC v2 migration lacks the v2-only
// `statuses` section. v2 always includes the key (possibly an empty
// array), so its absence is a reliable "this is a v1 snapshot" signal.
function isV1Snapshot(snapshot: Record<string, unknown> | null): boolean {
  return snapshot != null && !('statuses' in snapshot)
}

/** The snapshot keys a failed detail call left empty (TICCompanyProfile.incompleteSections). */
export function incompleteSectionsOf(snapshot: Record<string, unknown> | null | undefined): string[] {
  const keys = snapshot?.incompleteSections
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  return !Array.isArray(value) || value.length > 0
}

// Never taken from the previous snapshot: the annual report list. The
// closed-year reopen gate (fiscal_year_reopen_snapshot, the keys in
// FISCAL_YEAR_REOPEN_REGISTRY_KEYS) reads it as of tic_snapshot_fetched_at,
// so a list carried into a fresh snapshot would pass as fetched now and miss
// a report registered since. A failed documents call leaves it incomplete,
// and the gate refuses.
const NEVER_CARRIED = new Set(['financialReports', 'financialReportsComplete'])

/**
 * Whether two snapshots describe the same firm, by their registration number:
 * for an enskild firma the registration, not only the personnummer
 * (sameRegistration).
 */
function sameFirm(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return sameRegistration(
    typeof a.orgNumber === 'string' ? a.orgNumber : null,
    typeof b.orgNumber === 'string' ? b.orgNumber : null,
  )
}

/**
 * A fresh profile with the sections it could not fetch taken from the
 * previous snapshot, where that snapshot had them answered and non-empty: a
 * refetch while the budget is spent must not replace a known board with an
 * empty one. Sections with nothing to keep stay listed as incomplete, and so
 * does the annual report list (NEVER_CARRIED). A previous snapshot of another
 * number (the number was corrected since, or the search now picks another
 * registration of the same sole trader) describes another firm: nothing is
 * taken from it.
 */
export function keepLastKnownSections(
  fresh: Record<string, unknown>,
  previous: Record<string, unknown> | null,
): Record<string, unknown> {
  const missing = incompleteSectionsOf(fresh)
  if (missing.length === 0 || !previous || !sameFirm(fresh, previous)) return fresh
  const previousMissing = new Set(incompleteSectionsOf(previous))
  const merged: Record<string, unknown> = { ...fresh }
  const stillMissing: string[] = []
  for (const key of missing) {
    if (!NEVER_CARRIED.has(key) && !previousMissing.has(key) && hasContent(previous[key])) merged[key] = previous[key]
    else stillMissing.push(key)
  }
  merged.incompleteSections = stillMissing
  return merged
}

export async function ensureTicSnapshot(opts: {
  supabase: SupabaseClient
  companyId: string
  // When true, a cached snapshot still inside the 7-day window is
  // re-fetched if it's a pre-v2 (v1) shape. Gated to deliberate, bounded
  // callers so the v1→v2 upgrade doesn't fan out across
  // every company and exhaust the monthly TIC budget.
  upgradeV1?: boolean
  // Override the default 5s fetch timeout. Use when the caller has a UI
  // affordance for waiting (a spinner the user is watching) so legitimate
  // fetches don't get aborted before the ~13-call Lens fan-out completes:
  // which was the root cause of the May 2026 quota-burn incident.
  timeoutMs?: number
  // Keys the caller reads that older snapshots may lack: a cached snapshot
  // inside the 7-day window without every one of them is re-fetched, as a v1
  // snapshot is under upgradeV1. The closed-year reopen passes
  // financialReportsComplete, without which it cannot tell "no annual report
  // registered" from "could not ask".
  requireKeys?: readonly string[]
  // What the Lens calls of a live fetch are charged to in the monthly TIC
  // budget (lib/tic-budget). A spent purpose degrades to the cached snapshot.
  purpose?: TicCallPurpose
}): Promise<TicSnapshotResult> {
  const {
    supabase,
    companyId,
    upgradeV1 = false,
    timeoutMs = FETCH_TIMEOUT_MS,
    requireKeys = [],
    purpose = 'profile',
  } = opts

  const { data: companyRow } = await supabase
    .from('companies')
    .select('org_number, tic_snapshot, tic_snapshot_fetched_at')
    .eq('id', companyId)
    .single()

  if (!companyRow) return { snapshot: null, source: 'fallback', reason: 'unavailable' }

  const cachedSnapshot = companyRow.tic_snapshot as Record<string, unknown> | null
  const fetchedAt = companyRow.tic_snapshot_fetched_at as string | null
  const needsV2Upgrade = upgradeV1 && isV1Snapshot(cachedSnapshot)
  const lacksRequiredKey =
    cachedSnapshot != null && requireKeys.some((key) => !(key in cachedSnapshot))
  const maxAgeMs =
    incompleteSectionsOf(cachedSnapshot).length > 0 ? INCOMPLETE_RETRY_AFTER_MS : STALE_AFTER_MS

  // Fresh cache hit: nothing to do. (Unless the caller needs v2 fields and
  // the cache is still v1, in which case we fall through to a refetch.)
  if (
    cachedSnapshot &&
    !isOlderThan(fetchedAt, maxAgeMs) &&
    !needsV2Upgrade &&
    !lacksRequiredKey
  ) {
    return { snapshot: cachedSnapshot, source: 'cached' }
  }

  // Org number drifts: some onboarding flows persist it on company_settings
  // only. Prefer companies.org_number but
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
    return { snapshot: cachedSnapshot ?? null, source: 'fallback', reason: 'unavailable' }
  }

  const outcome = await fetchTicProfile(orgNumber, timeoutMs, purpose)
  if (outcome.kind !== 'found') {
    // Fall through with whatever (possibly stale) snapshot we already have.
    return { snapshot: cachedSnapshot ?? null, source: 'fallback', reason: outcome.kind }
  }
  const profile = keepLastKnownSections(outcome.profile, cachedSnapshot)

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

function isOlderThan(fetchedAt: string | null, maxAgeMs: number): boolean {
  if (!fetchedAt) return true
  const ts = Date.parse(fetchedAt)
  if (Number.isNaN(ts)) return true
  return Date.now() - ts > maxAgeMs
}

type ProfileOutcome =
  | { kind: 'found'; profile: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }

async function fetchTicProfile(
  orgNumber: string,
  timeoutMs: number,
  purpose: TicCallPurpose,
): Promise<ProfileOutcome> {
  // Loaded on use, not statically: the settings panel's refresh action reaches
  // this module from a client component, and a static registry import would
  // pull lib/init toward the browser build (check:guards static-init-import).
  const { extensionRegistry } = await import('@/lib/extensions/registry')
  const provider = (await extensionRegistry.getAll()).find(
    (ext) => typeof ext.services?.[FETCH_COMPANY_PROFILE_SERVICE] === 'function',
  )
  if (!provider) return { kind: 'unavailable' }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The Lens calls behind the profile keep running past the deadline (and
    // count against quota), exactly as an aborted HTTP fetch did; the caller
    // just stops waiting for them.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const result = await Promise.race([
      provider.services![FETCH_COMPANY_PROFILE_SERVICE](orgNumber, { purpose }) as Promise<Record<string, unknown> | null>,
      timeout,
    ])
    if (result === 'timeout') {
      log.warn('tic profile timed out', { timeoutMs })
      return { kind: 'unavailable' }
    }
    return result ? { kind: 'found', profile: result } : { kind: 'not_found' }
  } catch (err) {
    // TIC not configured, quota hit, upstream outage: a normal fallback, so
    // the caller degrades to whatever snapshot it already has.
    log.warn('tic profile fetch failed', { error: err instanceof Error ? err.message : String(err) })
    return { kind: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}
