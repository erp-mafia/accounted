import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { syncSkattekonto, SKATTEKONTO_LAST_SYNCED_AT_KEY } from '@/extensions/general/skatteverket/lib/skattekonto-sync'
import { computeSkattekontoDrift, maybeAlertDrift } from '@/extensions/general/skatteverket/lib/skattekonto-drift'
import { SkatteverketAuthError, type SkvAuth } from '@/extensions/general/skatteverket/lib/api-client'
import { SkatteverketSkattekontoError } from '@/extensions/general/skatteverket/lib/skattekonto-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'
import { listVerifiedCompanies, markGrantRevoked } from '@/extensions/general/skatteverket/lib/connection-store'
import { currentSkvEnvironment, hasVerifiedGrant } from '@/extensions/general/skatteverket/lib/resolve-auth'

ensureInitialized()

export const maxDuration = 60

/**
 * GET /api/extensions/skatteverket/skattekonto/sync/cron
 *
 * Daily skattekonto sync (cron 0 4 * * *: 04:00 UTC, 06:00 Swedish time).
 * Pulls saldo + transactions and persists them to skattekonto_transactions.
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
 * Skips a company if it was synced within the last hour (cooldown),
 * to keep manual + cron triggers from racing each other.
 *
 * Time budget: 50s (Vercel default 60s function timeout, 10s margin).
 *
 * Per-company errors are logged but do not abort the run. A system-token
 * minting failure (SYSTEM_AUTH_FAILED) short-circuits the remaining
 * system-mode entries (one config problem, not fifty) but user-mode entries
 * still run.
 */
export async function GET(request: Request) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  // Respect the runtime extension toggle. When the integration is disabled
  // the cron should no-op rather than spam Skatteverket with stale tokens.
  if (process.env.SKATTEVERKET_ENABLED !== 'true') {
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // User-token entries. The token row is keyed by user_id but carries
  // company_id (multi-tenant refactor). Rows flagged needs_reconsent are
  // excluded: SKV's per-flow refresh tokens live 65 minutes, so a connection
  // that failed with a terminal auth error can never heal on its own.
  const { data: tokens, error: tokensError } = await supabase
    .from('skatteverket_tokens')
    .select('user_id, company_id, expires_at, refresh_count')
    .eq('status', 'active')
    .order('expires_at', { ascending: true })
    .limit(50)

  if (tokensError) {
    console.error('[skattekonto-sync-cron] Failed to fetch tokens', {
      message: tokensError.message,
      code: tokensError.code,
    })
    return NextResponse.json({ error: 'Failed to fetch tokens' }, { status: 500 })
  }

  const systemAuthActive = getSystemAuthMode() === 'on' && isSystemAuthConfigured()
  const systemCompanies = systemAuthActive
    ? await listVerifiedCompanies(currentSkvEnvironment(), 'lasombud')
    : []

  type WorkItem = { companyId: string; userId: string; source: 'system' | 'user' }
  const tokenByCompany = new Map<string, string>()
  for (const token of tokens ?? []) {
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
  for (const token of tokens ?? []) {
    const companyId = token.company_id as string | null
    if (!companyId) {
      console.warn('[skattekonto-sync-cron] token without company_id skipped', {
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

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000
  const SYNC_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour
  const shadowMode = getSystemAuthMode() === 'shadow'

  type Result = {
    userId: string
    companyId: string
    source: 'system' | 'user'
    status: 'synced' | 'skipped_cooldown' | 'expired' | 'grant_revoked' | 'system_auth_failed' | 'error'
    booked?: number
    upcoming?: number
    error?: string
  }
  const results: Result[] = []
  // One config problem, not one per company: after the first minting
  // failure, skip the remaining system-mode entries this run.
  let systemAuthFailed = false

  for (const item of work) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`[skattekonto-sync-cron] Time budget reached after ${results.length} companies`)
      break
    }

    const { companyId, userId, source } = item

    if (source === 'system' && systemAuthFailed) {
      results.push({ userId, companyId, source, status: 'system_auth_failed', error: 'skipped after first failure' })
      continue
    }

    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      console.info('[skattekonto-sync-cron] skip: capability not entitled', { companyId })
      continue
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
          results.push({ userId, companyId, source, status: 'skipped_cooldown' })
          continue
        }
      }

      if (shadowMode) {
        // Rollout signal only: would this company have run on system auth?
        const grantReady = await hasVerifiedGrant(companyId, 'lasombud')
        console.info('[skattekonto-sync-cron] shadow: grant state', { companyId, grantReady })
      }

      const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')
      const auth: SkvAuth =
        source === 'system' ? { mode: 'system' } : { mode: 'user', supabase, userId }
      const syncResult = await syncSkattekonto(ctx, auth)

      // Drift check: compare the fresh SKV saldo against GL 1630 sum. Emits
      // `skattekonto.drift_detected` when |drift| > tolerance and not throttled.
      try {
        const drift = await computeSkattekontoDrift(ctx)
        if (drift) await maybeAlertDrift(ctx, drift)
      } catch (driftErr) {
        console.error('[skattekonto-sync-cron] Drift check failed', {
          userId,
          companyId,
          message: driftErr instanceof Error ? driftErr.message : String(driftErr),
        })
      }

      results.push({
        userId,
        companyId,
        source,
        status: 'synced',
        booked: syncResult.booked,
        upcoming: syncResult.upcoming,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (source === 'system' && err instanceof SkatteverketAuthError) {
        // System-mode failures never touch skatteverket_tokens.
        if (err.code === 'SYSTEM_AUTH_FAILED') {
          if (!systemAuthFailed) {
            systemAuthFailed = true
            console.warn(
              '[skattekonto-sync-cron] system token minting/authentication failed; skipping remaining system-mode entries this run',
              { companyId, message },
            )
          }
          results.push({ userId, companyId, source, status: 'system_auth_failed', error: err.code })
          continue
        }
        if (err.code === 'OMBUD_GRANT_MISSING') {
          // The company withdrew the behorighet: downgrade the connection
          // row so the next run falls back to the user token (if any). The
          // sync cron doubles as the ongoing grant liveness probe.
          await markGrantRevoked(companyId, currentSkvEnvironment(), 'lasombud', err.code)
          results.push({ userId, companyId, source, status: 'grant_revoked', error: err.code })
          continue
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
        await markNeedsReconsent(supabase, userId, err.code)
        results.push({ userId, companyId, source, status: 'expired', error: err.code })
        continue
      }
      // TOKEN_REVOKED auto-deletes the row inside skvRequest — treat it as
      // the same quiet "reconnect needed" outcome, not a runtime error.
      if (source === 'user' && err instanceof SkatteverketAuthError && err.code === 'TOKEN_REVOKED') {
        results.push({ userId, companyId, source, status: 'expired', error: err.code })
        continue
      }

      const felkod = err instanceof SkatteverketSkattekontoError ? err.felkod : null
      console.error('[skattekonto-sync-cron] Sync failed', {
        userId,
        companyId,
        source,
        message,
        felkod,
      })
      results.push({ userId, companyId, source, status: 'error', error: message })
    }
  }

  const synced = results.filter(r => r.status === 'synced').length
  const skipped = results.filter(r => r.status === 'skipped_cooldown').length
  const expired = results.filter(r => r.status === 'expired').length
  const grantRevoked = results.filter(r => r.status === 'grant_revoked').length
  const systemAuthFailures = results.filter(r => r.status === 'system_auth_failed').length
  const errors = results.filter(r => r.status === 'error').length

  console.log(
    `[skattekonto-sync-cron] Processed ${results.length}: ${synced} synced, ${skipped} cooldown, ${expired} expired, ${grantRevoked} grant revoked, ${systemAuthFailures} system-auth failures, ${errors} errors`,
  )

  return NextResponse.json({
    processed: results.length,
    synced,
    skipped,
    expired,
    grantRevoked,
    systemAuthFailures,
    errors,
    results,
  })
}
