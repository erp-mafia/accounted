import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { verifyCronSecret } from '@/lib/auth/cron'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { cronRunRaisesErrors } from '@/extensions/general/skatteverket/lib/cron-error-slot'
import { reconcileAgiDeclaration, type SkvGatewayRoute } from '@/extensions/general/skatteverket/lib/agi-kvittens-reconcile'
import { formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'

export const maxDuration = 60

// Every line goes through the structured logger: third-party error strings
// pass its redaction, and log.error is the level that reaches error tracking
// (console.* ends in Vercel stdout only, accounted#115).
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

  if (!isSkatteverketEnabled()) {
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

  // The batch starts at a random point in id order and wraps round to the
  // start. It was the oldest 100 by created_at, and a declaration nobody
  // signs (or whose company's BankID session is over) stays pending for
  // good: once a hundred of those had gathered, a declaration created after
  // them was never asked about. Ids are random (uuid v4), so every pending
  // declaration has the same chance in every run, with nothing to store.
  const PENDING_BATCH = 100
  const pivot = crypto.randomUUID()
  const readPending = (side: 'after' | 'upTo', count: number) => {
    const open = supabase
      .from('agi_declarations')
      .select('id, company_id, salary_run_id, period_year, period_month')
      .eq('status', 'pending_signature')
    return (side === 'after' ? open.gt('id', pivot) : open.lte('id', pivot))
      .order('id', { ascending: true })
      .limit(count)
  }
  const first = await readPending('after', PENDING_BATCH)
  const wrapped =
    !first.error && (first.data?.length ?? 0) < PENDING_BATCH
      ? await readPending('upTo', PENDING_BATCH - (first.data?.length ?? 0))
      : null
  const pendingError = first.error ?? wrapped?.error ?? null
  const pending = pendingError ? null : [...(first.data ?? []), ...(wrapped?.data ?? [])]

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
  // The slowest declaration is a token refresh (10 s before it is given up),
  // a second look at the stored token after a refresh race (1 s), the
  // Skatteverket call (15 s) and a handful of writes: started at 30 s it still
  // ends inside the route's 60 s. At 50 s (what the comment above the handler
  // still says) it could be cut off mid-write.
  const TIME_BUDGET_MS = 30_000
  // The cron's schedule (vercel.json): every 15 minutes.
  const CRON_INTERVAL_MS = 15 * 60 * 1000

  // No companyId here: results echo back in the HTTP response body, so
  // tenant identifiers stay in internal log context only (declarationId
  // is enough to find the row).
  type Result = {
    declarationId: string
    period: string
    status: 'signed' | 'still_pending' | 'already_claimed' | 'no_token' | 'no_company_settings' | 'expired_token' | 'gateway_refused' | 'error'
    error?: string
  }
  const results: Result[] = []
  // Declarations that could not be reconciled this run: the reconciler's
  // 'error' outcomes (Skatteverket's answer was not usable, or the kvittens
  // could not be saved), which were only in the response body nobody reads,
  // and failures thrown on the way. Reported once after the loop, with
  // Skatteverket's HTTP status or an error code and never the error text:
  // for a refused read that text is Skatteverket's message or body, which
  // for an enskild firma can carry the arbetsgivare's personnummer.
  const unreconciled: Array<{ declarationId: string; companyId: string; httpStatus?: number; code?: string }> = []
  // Filled when Skatteverket's gateway refuses the APIGW client itself. That
  // verdict is reached before any bearer is read, so it is the same for every
  // remaining declaration behind the same client: the run stops asking
  // instead of collecting one identical refusal (and one identical log line)
  // per declaration. Keyed by route because a company on the connector canary
  // reaches Skatteverket through the broker's client, not this installation's:
  // a refusal of one must never starve the companies behind the other. The
  // reconciler owns the route (it knows which credential it resolved) and
  // answers gateway_refused without calling for a route already in the set.
  const refusedRoutes = new Set<SkvGatewayRoute>()

  for (const decl of pending) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info('time budget reached', { declarations: results.length })
      break
    }

    const companyId = decl.company_id as string
    const declarationId = decl.id as string
    const period = formatRedovisningsperiod('monthly', decl.period_year as number, decl.period_month as number)

    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      log.info('skip: capability not entitled', { companyId })
      continue
    }

    try {
      // The shared reconciler resolves a member's user token (AGI reads never
      // run on ombud credentials), fetches the kvittens, and on a hit promotes the declaration +
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
        { reconciledBy: 'cron', refusedRoutes },
      )

      const result: Result = { declarationId, period, status: outcome.status }
      if ('error' in outcome) result.error = outcome.error
      results.push(result)
      if (outcome.status === 'error') {
        unreconciled.push(
          outcome.httpStatus !== undefined
            ? { declarationId, companyId, httpStatus: outcome.httpStatus }
            : { declarationId, companyId, code: 'recording_failed' },
        )
      }

      if (outcome.status === 'gateway_refused' && outcome.asked) {
        refusedRoutes.add(outcome.route)
        // warn, once per run, not error per declaration: this is a standing
        // operator-side state (the APIGW client has no subscription to the AGI
        // hantera API in Utvecklarportalen, #973 / #2226), not something a
        // retry, a reconnect or a code change can clear. Raising it as a fresh
        // error per declaration per tick buried the error stream (110 in two
        // days) without telling anyone anything new. The declarations stay
        // pending_signature and heal on the first run after the subscription
        // exists; the AGI panel tells the user the truth meanwhile.
        log.warn('Skatteverket gateway refuses the APIGW client for AGI kvittens reads; no further calls this run', {
          issue: '#2226',
          route: outcome.route,
          pending: pending.length,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (
        err instanceof SkatteverketAuthError &&
        (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
      ) {
        // Persist the health flag so both crons stop retrying this
        // connection and the UI can prompt for re-consent proactively. The
        // verdict names the token it is about (a company can hold one row per
        // connected member), and the flag lands on that row only while it is
        // still that token: not on one another job stored meanwhile.
        if (err.tokenRow) {
          await markNeedsReconsent(supabase, err.tokenRow.userId, companyId, err.code, err.tokenRow.version)
        }
        results.push({ declarationId, period, status: 'expired_token', error: err.code })
        continue
      }
      if (
        err instanceof SkatteverketAuthError &&
        (err.code === 'TOKEN_REVOKED' || err.code === 'NOT_CONNECTED')
      ) {
        // TOKEN_REVOKED: skvRequest already deleted the token row.
        // NOT_CONNECTED: the row was gone when the call read it, removed
        // meanwhile or being replaced by another job's refresh (storeTokens
        // deletes, then inserts; the skattekonto sync refreshes the same row
        // at the top of the hour). Not a failure: the next run reads the row
        // as it is, as the VAT and skattekonto crons already treat it.
        results.push({ declarationId, period, status: 'expired_token', error: err.code })
        continue
      }
      // The gateway refusing the APIGW client itself never reaches this catch:
      // the reconciler returns it as the gateway_refused outcome above. Every
      // other ACCESS_DENIED (kill switch, scope contract, generic 403) is a
      // real failure and lands in the error path like any other. It goes into
      // the run's report (error level once per six hours); this line, with
      // the message, is for whoever reads the run's own log.
      log.warn('Reconciliation failed', { declarationId, companyId, period, message })
      unreconciled.push({
        declarationId,
        companyId,
        code: err instanceof SkatteverketAuthError ? err.code : err instanceof Error ? err.name : 'unknown',
      })
      // An access denial keeps its machine-readable code in the body (as the
      // expired_token rows do): the keyword heuristic in
      // getErrorMessage misses the gateway wording and would collapse it
      // into "Något gick fel". The full guidance is in the log line above.
      const isAccessDenied = err instanceof SkatteverketAuthError && err.code === 'ACCESS_DENIED'
      results.push({
        declarationId,
        period,
        status: 'error',
        error: isAccessDenied ? err.code : getErrorMessage(err),
      })
    }
  }

  const signed = results.filter(r => r.status === 'signed').length
  const stillPending = results.filter(r => r.status === 'still_pending').length
  const alreadyClaimed = results.filter(r => r.status === 'already_claimed').length
  const expired = results.filter(r => r.status === 'expired_token').length
  const noToken = results.filter(r => r.status === 'no_token').length
  const errors = results.filter(r => r.status === 'error').length
  const gatewayRefused = refusedRoutes.size > 0

  // What could not be reconciled, by Skatteverket's HTTP status or error code.
  const failureKinds: Record<string, number> = {}
  for (const failure of unreconciled) {
    const kind = failure.httpStatus !== undefined ? `http_${failure.httpStatus}` : (failure.code ?? 'unknown')
    failureKinds[kind] = (failureKinds[kind] ?? 0) + 1
  }

  if (unreconciled.length > 0) {
    // One line per run with the counts, never one per declaration, and at
    // error level once per six hours: a declaration that keeps failing is in
    // every run until someone looks (cron-error-slot.ts). The kinds are in
    // the message, which is what error tracking groups by: a new kind (a
    // TypeError from a bug) opens a group of its own instead of joining a
    // standing, perhaps muted, Skatteverket refusal.
    const message = `agi kvittens: declarations could not be reconciled (kinds: ${Object.keys(failureKinds).sort().join(', ')})`
    const context = { count: unreconciled.length, failureKinds, declarations: unreconciled.slice(0, 20) }
    if (cronRunRaisesErrors(startTime, CRON_INTERVAL_MS)) log.error(message, context)
    else log.warn(message, context)
  }

  // no_token and expired_token are counted, not raised: a BankID session
  // lasts 65 minutes, so a connection that is over is where every company
  // ends up between visits, and only its user can renew it (the AGI panel
  // asks them to). Raising them here is the noise the reconsent flag removed.
  log.info('agi kvittens reconciliation run', {
    processed: results.length,
    signed,
    stillPending,
    alreadyClaimed,
    expired,
    noToken,
    errors,
    failureKinds,
    gatewayRefused,
  })

  return NextResponse.json(
    {
      processed: results.length,
      signed,
      stillPending,
      alreadyClaimed,
      expired,
      errors,
      gatewayRefused,
      results,
    },
    { headers: NO_STORE_HEADERS },
  )
}
