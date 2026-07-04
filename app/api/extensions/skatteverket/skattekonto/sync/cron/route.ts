import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { syncSkattekonto, SKATTEKONTO_LAST_SYNCED_AT_KEY } from '@/extensions/general/skatteverket/lib/skattekonto-sync'
import { computeSkattekontoDrift, maybeAlertDrift } from '@/extensions/general/skatteverket/lib/skattekonto-drift'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { SkatteverketSkattekontoError } from '@/extensions/general/skatteverket/lib/skattekonto-client'

ensureInitialized()

export const maxDuration = 60

/**
 * GET /api/extensions/skatteverket/skattekonto/sync/cron
 *
 * Daily skattekonto sync (cron 0 4 * * *: 04:00 UTC, 06:00 Swedish time).
 * Pulls saldo + transactions for every company that has a connected
 * Skatteverket token, and persists the results to skattekonto_transactions.
 *
 * Skips a company if it was synced within the last hour (cooldown),
 * to keep manual + cron triggers from racing each other.
 *
 * Time budget: 50s (Vercel default 60s function timeout, 10s margin).
 *
 * Per-company errors are logged but do not abort the run: one expired
 * token shouldn't block 49 other working syncs.
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

  // Find all companies with a connected token. The token row is keyed by
  // user_id but carries company_id (added in the multi-tenant refactor).
  const { data: tokens, error: tokensError } = await supabase
    .from('skatteverket_tokens')
    .select('user_id, company_id, expires_at, refresh_count')
    .order('expires_at', { ascending: true })
    .limit(50)

  if (tokensError) {
    console.error('[skattekonto-sync-cron] Failed to fetch tokens', {
      message: tokensError.message,
      code: tokensError.code,
    })
    return NextResponse.json({ error: 'Failed to fetch tokens' }, { status: 500 })
  }

  if (!tokens || tokens.length === 0) {
    return NextResponse.json({ message: 'No connected tokens', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000
  const SYNC_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

  type Result = {
    userId: string
    companyId: string
    status: 'synced' | 'skipped_cooldown' | 'expired' | 'error'
    booked?: number
    upcoming?: number
    error?: string
  }
  const results: Result[] = []

  for (const token of tokens) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`[skattekonto-sync-cron] Time budget reached after ${results.length} tokens`)
      break
    }

    const userId = token.user_id as string
    const companyId = token.company_id as string | null

    if (!companyId) {
      // Pre-multi-tenant tokens may lack company_id. Skip: cannot scope.
      results.push({ userId, companyId: '(missing)', status: 'error', error: 'No company_id on token' })
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
          results.push({ userId, companyId, status: 'skipped_cooldown' })
          continue
        }
      }

      const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')
      const syncResult = await syncSkattekonto(ctx)

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
        status: 'synced',
        booked: syncResult.booked,
        upcoming: syncResult.upcoming,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      // Expired token / refresh exhausted is a known outcome: surface it
      // distinctly so ops can dashboard "X companies need to reconnect".
      if (
        err instanceof SkatteverketAuthError &&
        (err.code === 'REFRESH_EXHAUSTED' || err.code === 'SESSION_EXPIRED' || err.code === 'TOKEN_CORRUPTED')
      ) {
        results.push({ userId, companyId, status: 'expired', error: err.code })
        continue
      }

      const felkod = err instanceof SkatteverketSkattekontoError ? err.felkod : null
      console.error('[skattekonto-sync-cron] Sync failed', {
        userId,
        companyId,
        message,
        felkod,
      })
      results.push({ userId, companyId, status: 'error', error: message })
    }
  }

  const synced = results.filter(r => r.status === 'synced').length
  const skipped = results.filter(r => r.status === 'skipped_cooldown').length
  const expired = results.filter(r => r.status === 'expired').length
  const errors = results.filter(r => r.status === 'error').length

  console.log(
    `[skattekonto-sync-cron] Processed ${results.length}: ${synced} synced, ${skipped} cooldown, ${expired} expired, ${errors} errors`,
  )

  return NextResponse.json({
    processed: results.length,
    synced,
    skipped,
    expired,
    errors,
    results,
  })
}
