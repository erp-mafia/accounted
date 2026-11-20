import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { orderByStalestSync } from '@/lib/skatteverket/sync-order'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import {
  syncSkattekonto,
  skattekontoUnavailableReason,
  SKATTEKONTO_LAST_SYNCED_AT_KEY,
  SKATTEKONTO_UNAVAILABLE_KEY,
  type SkattekontoUnavailableState,
} from '@/extensions/general/skatteverket/lib/skattekonto-sync'
import { SkatteverketAuthError, type SkvAuth } from '@/extensions/general/skatteverket/lib/api-client'
import { SkatteverketSkattekontoError } from '@/extensions/general/skatteverket/lib/skattekonto-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'
import { listVerifiedCompanies } from '@/extensions/general/skatteverket/lib/connection-store'
import { recordGrantRefusal } from '@/extensions/general/skatteverket/lib/grant-probe'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { currentSkvEnvironment, hasVerifiedGrant } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'
import { createLogger } from '@/lib/logger'

const log = createLogger('cron/skattekonto-sync')

// Head room past the 50 s work budget: syncs already in flight when the
// budget closes finish instead of being killed mid-write at the platform
// timeout (two "Task timed out after 60 seconds" kills before B07).
export const maxDuration = 120

const MAX_COMPANIES_PER_RUN = 50

/**
 * Companies synced at once. A sync is mostly waiting on Skatteverket and the
 * database (~2 s each, so one-by-one ran out of the 50 s budget at ~23
 * companies and skipped the rest every hour, B07). SKV's 4 req/s quota is
 * still kept: every call goes through the transport's process-wide limiter.
 */
const SYNC_CONCURRENCY = 4

/**
 * How often a company whose skattekonto Skatteverket would not hand over
 * (no account yet, or the consenting person not authorized) is asked again.
 * The answer changes in Skatteverket's nightly registers, not hour by hour;
 * three hours still catches the change within a ~10 hour BankID consent. A
 * manual sync or a new consent asks at once.
 */
const UNAVAILABLE_RECHECK_MS = 3 * 60 * 60 * 1000

/**
 * GET /api/extensions/skatteverket/skattekonto/sync/cron
 *
 * Hourly skattekonto sync (cron 0 * * * *). Hourly because an ombud
 * company costs one shared system token and two reads per run, and its
 * skattekonto should be as fresh as a logged-in user's; a personal session
 * that is alive at the top of the hour is synced too. Pulls saldo +
 * transactions and persists them to skattekonto_transactions.
 *
 * Work list is a union keyed by company:
 *   1. System-mode entries: companies with a verified lasombud grant, synced
 *      on Accounted's own CCG credentials (no user token involved, so the
 *      65-minute personal-token lifetime stops mattering here). Active only
 *      when SKATTEVERKET_SYSTEM_AUTH_MODE=on.
 *   2. User-mode entries: companies with an active personal token, exactly
 *      the pre-hybrid behavior. Fallback during the transition and for
 *      companies that never grant the behorighet.
 *
 * Shadow mode logs per user-mode company whether a verified grant exists,
 * without any behavior change: the rollout confidence signal.
 *
 * Skips a company if it was synced within the last 50 minutes (cooldown),
 * to keep manual + cron triggers from racing each other. Under an hour so
 * the previous hourly run never blocks the next one.
 *
 * Skatteverket answering "no skattekonto for this org number" (404, typical
 * for a newly formed company) or "this person is not authorized" (403
 * felkod 6) is a state, not a failure: syncSkattekonto stores it for the
 * settings panel, the run reports it as `unavailable`, and the company is
 * asked again every UNAVAILABLE_RECHECK_MS instead of every hour.
 *
 * Time budget: 50s of starting new syncs, SYNC_CONCURRENCY at a time;
 * maxDuration leaves room for the ones in flight to finish.
 *
 * Per-company errors are logged but do not abort the run. A system-token
 * minting failure (SYSTEM_AUTH_FAILED) short-circuits the remaining
 * system-mode entries (one config problem, not fifty) but user-mode entries
 * still run.
 */
export const GET = withCronContext('cron.skatteverket_skattekonto_sync', async () => {
  // Respect the runtime extension toggle. When the integration is disabled
  // the cron should no-op rather than spam Skatteverket with stale tokens.
  if (!isSkatteverketEnabled()) {
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  // User-token entries. The token row is keyed by user_id but carries
  // company_id (multi-tenant refactor). Rows flagged needs_reconsent are
  // excluded: SKV's per-flow refresh tokens live 65 minutes, so a connection
  // that failed with a terminal auth error can never heal on its own.
  let tokens
  try {
    tokens = await fetchAllRows(
      ({ from, to }) => supabase
        .from('skatteverket_tokens')
        .select('user_id, company_id, expires_at, refresh_count')
        .eq('status', 'active')
        .order('expires_at', { ascending: true })
        .order('user_id', { ascending: true })
        .range(from, to),
      // One row per (user, company) since tokens went per-company: deduping by
      // user alone would drop every company but one for multi-company operators.
      { dedupeBy: token => `${token.user_id}:${token.company_id}` },
    )
  } catch (error) {
    log.error('Failed to fetch tokens', {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Failed to fetch tokens' }, { status: 500 })
  }

  const systemAuthActive = getSystemAuthMode() === 'on' && isSystemAuthConfigured()
  const systemCompanies = systemAuthActive
    ? await listVerifiedCompanies(currentSkvEnvironment(), 'lasombud')
    : []

  type WorkItem = { companyId: string; userId: string; source: 'system' | 'user' }
  const tokenByCompany = new Map<string, string>()
  for (const token of tokens) {
    if (token.company_id) tokenByCompany.set(token.company_id as string, token.user_id as string)
  }

  const work: WorkItem[] = []
  const systemCompanyIds = new Set<string>()
  for (const company of systemCompanies) {
    // ctx still needs a user identity (events, drift emails). Prefer the
    // token owner, fall back to whoever verified the grant.
    const userId = tokenByCompany.get(company.company_id) ?? company.created_by
    if (!userId) continue
    systemCompanyIds.add(company.company_id)
    work.push({ companyId: company.company_id, userId, source: 'system' })
  }
  for (const token of tokens) {
    const companyId = token.company_id as string | null
    if (!companyId) {
      log.warn('token without company_id skipped', {
        userId: token.user_id,
      })
      continue
    }
    if (systemCompanyIds.has(companyId)) continue
    work.push({ companyId, userId: token.user_id as string, source: 'user' })
  }

  if (work.length === 0) {
    return NextResponse.json({ message: 'No connected companies', processed: 0 })
  }

  let entitledCompanyIds
  try {
    entitledCompanyIds = await getCompanyIdsWithCapability(
      supabase,
      work.map(item => item.companyId),
      CAPABILITY.skatteverket,
    )
  } catch (error) {
    log.error('Failed to resolve entitled companies', {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Failed to resolve entitlements' }, { status: 500 })
  }

  // Limit the eligible work list, not the raw token list. Expired trials and
  // disabled modules must not occupy all 50 positions ahead of paying firms.
  // Within the eligible list, never-synced and longest-ago-synced companies
  // go first: a fixed order plus a cap starves the tail forever.
  const eligibleWork = work.filter(item => entitledCompanyIds.has(item.companyId))
  const lastSyncedAtByCompany = new Map<string, string | null>()
  const unavailableByCompany = new Map<string, SkattekontoUnavailableState>()
  try {
    const rows = await fetchAllRows(
      ({ from, to }) => supabase
        .from('extension_data')
        .select('company_id, key, value')
        .eq('extension_id', 'skatteverket')
        .in('key', [SKATTEKONTO_LAST_SYNCED_AT_KEY, SKATTEKONTO_UNAVAILABLE_KEY])
        .order('company_id', { ascending: true })
        .order('key', { ascending: true })
        .range(from, to),
    )
    for (const r of rows ?? []) {
      if (r.key === SKATTEKONTO_UNAVAILABLE_KEY) {
        const state = r.value as SkattekontoUnavailableState | null
        if (state?.checkedAt) unavailableByCompany.set(r.company_id as string, state)
      } else {
        lastSyncedAtByCompany.set(r.company_id as string, (r.value as string | null) ?? null)
      }
    }
  } catch (error) {
    log.warn('last-synced read failed; keeping token order', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  // Order by the last time Skatteverket was ASKED, not only the last time it
  // handed data over: a company with no skattekonto yet never gets a
  // last-synced stamp and would otherwise jump the queue on every run.
  const lastAskedAtByCompany = new Map(lastSyncedAtByCompany)
  for (const [companyId, state] of unavailableByCompany) {
    const synced = lastAskedAtByCompany.get(companyId)
    if (!synced || state.checkedAt > synced) lastAskedAtByCompany.set(companyId, state.checkedAt)
  }
  const entitledWork = orderByStalestSync(eligibleWork, lastAskedAtByCompany).slice(0, MAX_COMPANIES_PER_RUN)

  log.info('Work list built', {
    candidates: work.length,
    entitledCompanies: entitledCompanyIds.size,
    selected: entitledWork.length,
  })

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000
  const SYNC_COOLDOWN_MS = 50 * 60 * 1000 // 50 minutes, under the hourly schedule
  const shadowMode = getSystemAuthMode() === 'shadow'

  type Result = {
    userId: string
    companyId: string
    source: 'system' | 'user'
    status:
      | 'synced'
      | 'skipped_cooldown'
      | 'unavailable'
      | 'expired'
      | 'not_connected'
      | 'grant_withdrawn'
      | 'grant_refused'
      | 'system_auth_failed'
      | 'error'
    booked?: number
    upcoming?: number
    error?: string
  }
  const results: Result[] = []
  // One config problem, not one per company: after the first minting
  // failure, skip the remaining system-mode entries this run.
  let systemAuthFailed = false

  const syncOne = async (item: WorkItem): Promise<Result> => {
    const { companyId, userId, source } = item

    if (source === 'system' && systemAuthFailed) {
      return { userId, companyId, source, status: 'system_auth_failed', error: 'skipped after first failure' }
    }

    // Skatteverket would not hand the skattekonto over a moment ago (no
    // account yet / person not authorized): ask again on the slower cadence.
    const unavailableState = unavailableByCompany.get(companyId)
    if (
      unavailableState &&
      Date.now() - new Date(unavailableState.checkedAt).getTime() < UNAVAILABLE_RECHECK_MS
    ) {
      return { userId, companyId, source, status: 'skipped_cooldown', error: unavailableState.reason }
    }

    try {
      // Cooldown: skip if synced within the last hour.
      const { data: lastSyncRow } = await supabase
        .from('extension_data')
        .select('value, updated_at')
        .eq('company_id', companyId)
        .eq('extension_id', 'skatteverket')
        .eq('key', SKATTEKONTO_LAST_SYNCED_AT_KEY)
        .maybeSingle()

      const lastSyncedAt = lastSyncRow?.value as string | undefined
      if (lastSyncedAt) {
        const elapsed = Date.now() - new Date(lastSyncedAt).getTime()
        if (elapsed < SYNC_COOLDOWN_MS) {
          return { userId, companyId, source, status: 'skipped_cooldown' }
        }
      }

      if (shadowMode) {
        // Rollout signal only: would this company have run on system auth?
        const grantReady = await hasVerifiedGrant(companyId, 'lasombud')
        log.info('shadow: grant state', { companyId, grantReady })
      }

      const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')
      const auth: SkvAuth =
        source === 'system' ? { mode: 'system' } : { mode: 'user', supabase, userId, companyId }
      const syncResult = await syncSkattekonto(ctx, auth)

      return {
        userId,
        companyId,
        source,
        status: 'synced',
        booked: syncResult.booked,
        upcoming: syncResult.upcoming,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      // Skatteverket's answer was a state of the account or the person, not
      // a failure: syncSkattekonto already stored it for the settings panel.
      // A system-mode 403 never lands here (it is OMBUD_GRANT_MISSING).
      const unavailableReason = skattekontoUnavailableReason(err)
      if (unavailableReason) {
        return { userId, companyId, source, status: 'unavailable', error: unavailableReason }
      }

      if (source === 'system' && err instanceof SkatteverketAuthError) {
        // System-mode failures never touch skatteverket_tokens.
        if (err.code === 'SYSTEM_AUTH_FAILED') {
          if (!systemAuthFailed) {
            systemAuthFailed = true
            // Every company on the system grant stops syncing until the
            // certificate, secret or scope is fixed: an error, not a warning.
            log.error('system token minting/authentication failed; skipping remaining system-mode entries this run', {
              companyId,
              message,
            })
          }
          return { userId, companyId, source, status: 'system_auth_failed', error: err.code }
        }
        if (err.code === 'OMBUD_GRANT_MISSING') {
          // The ombudsregister decides whether the company withdrew the
          // behorighet: then the row is downgraded and the next run falls
          // back to the user token (if any). The sync cron doubles as the
          // ongoing grant liveness probe.
          const grant = await recordGrantRefusal(companyId, 'lasombud')
          return { userId, companyId, source, status: grant === 'withdrawn' ? 'grant_withdrawn' : 'grant_refused', error: err.code }
        }
      }

      // Terminal user-token auth states are a known outcome: surface them
      // distinctly, persist the health flag so this cron stops retrying the
      // row, and let the UI prompt for re-consent proactively.
      if (
        source === 'user' &&
        err instanceof SkatteverketAuthError &&
        (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
      ) {
        await markNeedsReconsent(supabase, userId, companyId, err.code, err.tokenRow?.version)
        return { userId, companyId, source, status: 'expired', error: err.code }
      }
      // TOKEN_REVOKED auto-deletes the row inside skvRequest - treat it as
      // the same quiet "reconnect needed" outcome, not a runtime error.
      if (source === 'user' && err instanceof SkatteverketAuthError && err.code === 'TOKEN_REVOKED') {
        return { userId, companyId, source, status: 'expired', error: err.code }
      }
      // The token row listed above was gone when the sync read it: the
      // connection was removed meanwhile, or another process was replacing
      // the row on a refresh (storeTokens deletes, then inserts; the AGI
      // kvittens cron refreshes the same row at the top of the hour). Each
      // such "Sync failed" logged in production on 2026-11-05/06 was the
      // second: the row was back a moment later. Not a failure; the next run
      // reads the row as it is.
      if (source === 'user' && err instanceof SkatteverketAuthError && err.code === 'NOT_CONNECTED') {
        return { userId, companyId, source, status: 'not_connected', error: err.code }
      }

      const felkod = err instanceof SkatteverketSkattekontoError ? err.felkod : null
      log.error('Sync failed', {
        userId,
        companyId,
        source,
        message,
        felkod,
      })
      return { userId, companyId, source, status: 'error', error: getErrorMessage(err) }
    }
  }

  // A small worker pool over the ordered list: each worker takes the next
  // company until the list is done or the budget closes. Results keep the
  // work-list order.
  const slots: (Result | undefined)[] = new Array(entitledWork.length)
  let nextIndex = 0
  let budgetReached = false
  const worker = async () => {
    while (nextIndex < entitledWork.length) {
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        budgetReached = true
        return
      }
      const index = nextIndex++
      slots[index] = await syncOne(entitledWork[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SYNC_CONCURRENCY, entitledWork.length) }, () => worker()),
  )
  for (const result of slots) {
    if (result) results.push(result)
  }
  if (budgetReached) {
    log.info('time budget reached', { companies: results.length })
  }

  const synced = results.filter(r => r.status === 'synced').length
  const skipped = results.filter(r => r.status === 'skipped_cooldown').length
  const unavailable = results.filter(r => r.status === 'unavailable').length
  const expired = results.filter(r => r.status === 'expired').length
  const notConnected = results.filter(r => r.status === 'not_connected').length
  const grantWithdrawn = results.filter(r => r.status === 'grant_withdrawn').length
  const grantRefused = results.filter(r => r.status === 'grant_refused').length
  const systemAuthFailures = results.filter(r => r.status === 'system_auth_failed').length
  const errors = results.filter(r => r.status === 'error').length

  log.info('skattekonto sync run', {
    processed: results.length,
    synced,
    skipped,
    unavailable,
    expired,
    notConnected,
    grantWithdrawn,
    grantRefused,
    systemAuthFailures,
    errors,
  })

  return NextResponse.json({
    processed: results.length,
    synced,
    skipped,
    unavailable,
    expired,
    notConnected,
    grantWithdrawn,
    grantRefused,
    systemAuthFailures,
    errors,
    results,
  })
})
