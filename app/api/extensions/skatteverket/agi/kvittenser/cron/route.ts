import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createLogger } from '@/lib/logger'
import { verifyCronSecret } from '@/lib/auth/cron'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { currentSkvEnvironment, findCompanyTokenUser } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { markGrantRevoked } from '@/extensions/general/skatteverket/lib/connection-store'
import { reconcileAgiDeclaration } from '@/extensions/general/skatteverket/lib/agi-kvittens-reconcile'
import { formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const maxDuration = 60

// Failure logs route through the structured logger so third-party error
// strings pass its redaction. The APIGW warn / budget + summary logs /
// capability skip stay on console.*: their content is fixed internal strings.
const log = createLogger('agi-kvittenser-cron')

// Cron responses must never be cached: they report a point-in-time run.
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const

/**
 * GET /api/extensions/skatteverket/agi/kvittenser/cron
 *
 * Daily kvittens reconciliation. The user-side flow signs the AGI in
 * Skatteverket's Mina Sidor; the resulting kvittens (uuidKvittens +
 * signeradTid) is the canonical filing receipt. Without this cron,
 * `salary_runs.agi_submitted_at` only gets stamped when the user returns
 * to the panel and clicks "Hämta kvittens" or stays on the page long
 * enough for the in-browser timers to fire, which is unreliable, and
 * leaves the audit trail out of step with reality (BFNAR 2013:2 kap 8 +
 * BFL 5 kap 5§ require the behandlingshistorik to faithfully record
 * filing events).
 *
 * Strategy: walk every `agi_declarations` row in `pending_signature`
 * status, look up its arbetsgivare/period, fetch /kvittenser via the
 * extension's per-user token, and on a hit promote the row to
 * `submitted` + stamp salary_runs.agi_submitted_at.
 *
 * Per-row errors are logged and skipped: one expired token shouldn't
 * block other companies' reconciliation.
 *
 * Time budget: 50s (Vercel default 60s function timeout with 10s margin).
 */
export async function GET(request: Request) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  if (process.env.SKATTEVERKET_ENABLED !== 'true') {
    return NextResponse.json(
      { message: 'Skatteverket extension disabled', processed: 0 },
      { headers: NO_STORE_HEADERS },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: 'Missing Supabase configuration' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const { data: pending, error: pendingError } = await supabase
    .from('agi_declarations')
    .select('id, company_id, salary_run_id, period_year, period_month')
    .eq('status', 'pending_signature')
    .order('created_at', { ascending: true })
    .limit(100)

  if (pendingError) {
    log.error('Failed to fetch pending declarations', {
      message: pendingError.message,
      code: pendingError.code,
    })
    return NextResponse.json(
      { error: 'Failed to fetch pending declarations' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json(
      { message: 'No pending signatures', processed: 0 },
      { headers: NO_STORE_HEADERS },
    )
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000

  // No companyId here: results echo back in the HTTP response body, so
  // tenant identifiers stay in internal log context only (declarationId
  // is enough to find the row).
  type Result = {
    declarationId: string
    period: string
    status: 'signed' | 'still_pending' | 'already_claimed' | 'no_token' | 'no_company_settings' | 'expired_token' | 'grant_revoked' | 'apigw_config' | 'error'
    error?: string
  }
  const results: Result[] = []
  // The APIGW subscription gap is one run-level configuration problem, not a
  // per-declaration one: warn once per run instead of spamming an identical
  // warning for every affected declaration.
  let apigwAccessDeniedWarned = false

  for (const decl of pending) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`[agi-kvittenser-cron] Time budget reached after ${results.length} declarations`)
      break
    }

    const companyId = decl.company_id as string
    const declarationId = decl.id as string
    const period = formatRedovisningsperiod('monthly', decl.period_year as number, decl.period_month as number)

    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      console.info('[agi-kvittenser-cron] skip: capability not entitled', { companyId })
      continue
    }

    try {
      // The shared reconciler resolves auth (system grant → user token),
      // fetches the kvittens, and on a hit promotes the declaration +
      // stamps salary_runs / deadline / notification. Auth errors propagate
      // to the catch below, which owns the cron-specific side effects.
      const outcome = await reconcileAgiDeclaration(
        supabase,
        {
          id: declarationId,
          company_id: companyId,
          salary_run_id: (decl.salary_run_id as string | null) ?? null,
          period_year: decl.period_year as number,
          period_month: decl.period_month as number,
        },
        { reconciledBy: 'cron' },
      )

      const result: Result = { declarationId, period, status: outcome.status }
      if ('error' in outcome) result.error = outcome.error
      results.push(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (err instanceof SkatteverketAuthError && err.code === 'OMBUD_GRANT_MISSING') {
        // System-mode read rejected: the company withdrew the behorighet.
        // Downgrade the connection row so the next run falls back to the
        // user token (if any). Never touches skatteverket_tokens.
        await markGrantRevoked(companyId, currentSkvEnvironment(), 'lasombud', err.code)
        results.push({ declarationId, period, status: 'grant_revoked', error: err.code })
        continue
      }

      if (
        err instanceof SkatteverketAuthError &&
        (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
      ) {
        // Persist the health flag so both crons stop retrying this
        // connection and the UI can prompt for re-consent proactively.
        // Same pick as the reconciler's resolveReadAuth (a company can hold
        // one row per connected member), so the flag lands on the row that
        // just failed.
        const tokenRow = await findCompanyTokenUser(supabase, companyId)
        if (tokenRow) {
          await markNeedsReconsent(supabase, tokenRow.userId, companyId, err.code)
        }
        results.push({ declarationId, period, status: 'expired_token', error: err.code })
        continue
      }
      if (err instanceof SkatteverketAuthError && err.code === 'TOKEN_REVOKED') {
        // skvRequest already deleted the token row.
        results.push({ declarationId, period, status: 'expired_token', error: err.code })
        continue
      }
      if (err instanceof SkatteverketAuthError && err.code === 'ACCESS_DENIED') {
        // Skatteverkets API gateway rejected our client credentials before
        // the user's bearer was ever evaluated: the APIGW client
        // (SKATTEVERKET_APIGW_CLIENT_ID) lacks an Utvecklarportalen
        // subscription for the AGI hantera API. Retrying every run cannot
        // heal this and the user reconnecting via BankID does not help, so
        // log at warn level instead of error to keep the 2h cron from
        // producing error-noise for a known configuration gap. The distinct
        // status keeps the gap visible in the run summary until fixed. The
        // warn is emitted once per run (context is the first affected
        // declaration); every affected declaration still lands in results.
        if (!apigwAccessDeniedWarned) {
          apigwAccessDeniedWarned = true
          console.warn(
            '[agi-kvittenser-cron] APIGW client lacks Utvecklarportalen subscription for the AGI hantera API; check SKATTEVERKET_APIGW_CLIENT_ID subscriptions. Skipping affected declarations until the subscription is added.',
            { declarationId, companyId, period, message },
          )
        }
        results.push({ declarationId, period, status: 'apigw_config', error: err.code })
        continue
      }

      log.error('Reconciliation failed', { declarationId, companyId, period, message })
      results.push({ declarationId, period, status: 'error', error: getErrorMessage(err) })
    }
  }

  const signed = results.filter(r => r.status === 'signed').length
  const stillPending = results.filter(r => r.status === 'still_pending').length
  const alreadyClaimed = results.filter(r => r.status === 'already_claimed').length
  const expired = results.filter(r => r.status === 'expired_token').length
  const grantRevoked = results.filter(r => r.status === 'grant_revoked').length
  const apigwConfig = results.filter(r => r.status === 'apigw_config').length
  const errors = results.filter(r => r.status === 'error').length

  console.log(
    `[agi-kvittenser-cron] Processed ${results.length}: ${signed} signed, ${stillPending} still pending, ${alreadyClaimed} already claimed, ${expired} expired, ${grantRevoked} grants revoked, ${apigwConfig} apigw config gaps, ${errors} errors`,
  )

  return NextResponse.json(
    {
      processed: results.length,
      signed,
      stillPending,
      alreadyClaimed,
      expired,
      grantRevoked,
      apigwConfig,
      errors,
      results,
    },
    { headers: NO_STORE_HEADERS },
  )
}
