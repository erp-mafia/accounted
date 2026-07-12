import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { agiGetKvittenser } from '@/extensions/general/skatteverket/lib/agi-client'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'
import { resolveReadAuth, currentSkvEnvironment } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { markGrantRevoked } from '@/extensions/general/skatteverket/lib/connection-store'
import { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

ensureInitialized()

export const maxDuration = 60

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
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { data: pending, error: pendingError } = await supabase
    .from('agi_declarations')
    .select('id, company_id, salary_run_id, period_year, period_month')
    .eq('status', 'pending_signature')
    .order('created_at', { ascending: true })
    .limit(100)

  if (pendingError) {
    console.error('[agi-kvittenser-cron] Failed to fetch pending declarations', {
      message: pendingError.message,
      code: pendingError.code,
    })
    return NextResponse.json({ error: 'Failed to fetch pending declarations' }, { status: 500 })
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({ message: 'No pending signatures', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000

  type Result = {
    declarationId: string
    companyId: string
    period: string
    status: 'signed' | 'still_pending' | 'no_token' | 'no_company_settings' | 'expired_token' | 'grant_revoked' | 'apigw_config' | 'error'
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
      // Auth resolution prefers system credentials (verified lasombud grant)
      // and falls back to the company's user token: kvittens polling is the
      // canonical case for the hybrid model, since the user signed at SKV
      // and their 65-minute session is usually long dead by the time the
      // kvittens exists.
      const resolved = await resolveReadAuth(supabase, companyId, { requires: 'lasombud' })
      if (!resolved.ok) {
        if (resolved.reason === 'needs_reconsent') {
          // A connection flagged needs_reconsent cannot heal on its own
          // (SKV's per-flow refresh tokens live 65 minutes): skip quietly
          // instead of failing the same declaration every run.
          results.push({ declarationId, companyId, period, status: 'expired_token', error: 'needs_reconsent' })
        } else {
          results.push({ declarationId, companyId, period, status: 'no_token' })
        }
        continue
      }

      const { data: settings } = await supabase
        .from('company_settings')
        .select('org_number, entity_type')
        .eq('company_id', companyId)
        .single()

      if (!settings?.org_number) {
        results.push({ declarationId, companyId, period, status: 'no_company_settings' })
        continue
      }

      const arbetsgivare = formatRedovisare(
        settings.org_number as string,
        settings.entity_type as 'enskild_firma' | 'aktiebolag',
      )

      const kvittRes = await agiGetKvittenser(resolved.auth, arbetsgivare, period)
      if (!kvittRes.ok) {
        results.push({
          declarationId, companyId, period,
          status: 'error',
          error: kvittRes.error,
        })
        continue
      }

      const kvittens = kvittRes.data.kvittenser?.[0]
      if (!kvittens?.uuidKvittens) {
        results.push({ declarationId, companyId, period, status: 'still_pending' })
        continue
      }

      // The presence of uuidKvittens confirms SKV signed and accepted
      // the AGI. signeradTid is the precise signing moment; if SKV omits
      // it we fall back to reconciliation time + warn so the discrepancy
      // is investigable. Leaving NULL would hide that the filing occurred
      // at all, which itself misstates behandlingshistorik (BFNAR 2013:2
      // kap 8 / BFL 5 kap 6§). The fallback only applies on this code
      // path because we're inside the kvittens-found branch above.
      const submittedAt = kvittens.signeradTid || new Date().toISOString()
      if (!kvittens.signeradTid) {
        console.warn('[agi-kvittenser-cron] kvittens missing signeradTid; using reconciliation time', {
          declarationId, companyId, period, uuidKvittens: kvittens.uuidKvittens,
        })
      }

      // submitted_by is the token-owning auth.users row: the human who
      // connected via BankID. The legally load-bearing signer identity
      // is kvittens.signeradAv (a personnummer), which the token user_id
      // does NOT necessarily match (e.g. if the connected user is a
      // bookkeeper but the deklarationsombud signed). We preserve the
      // full kvittens in response_data so the audit trail (BFL 5 kap 6§,
      // BFNAR 2013:2 kap 8) records the actual BankID signer regardless
      // of who triggered the reconciliation.
      await supabase
        .from('agi_declarations')
        .update({
          status: 'submitted',
          kvittensnummer: kvittens.uuidKvittens,
          submitted_at: submittedAt,
          submitted_by: resolved.tokenUserId,
          response_data: {
            signeradAv: kvittens.signeradAv ?? null,
            signeradTid: kvittens.signeradTid ?? null,
            uuidKvittens: kvittens.uuidKvittens,
            arbetsgivare: kvittens.arbetsgivare ?? null,
            period: kvittens.period ?? null,
            underlag: kvittens.underlag ?? null,
            reconciledBy: 'cron',
          },
        })
        .eq('id', declarationId)

      if (decl.salary_run_id) {
        await supabase
          .from('salary_runs')
          .update({ agi_submitted_at: submittedAt })
          .eq('id', decl.salary_run_id)
          .eq('company_id', companyId)
      }

      // Clear the locally-cached submission state so the panel doesn't
      // pop a stale "awaiting signature" view if the user revisits.
      await supabase
        .from('extension_data')
        .delete()
        .eq('company_id', companyId)
        .eq('extension_id', 'skatteverket')
        .eq('key', `agi_submission_${period}`)

      // The declaration is already flipped to submitted above, and the next
      // run only revisits pending_signature rows: from here on everything is
      // best-effort. Each step gets its own try/catch so a failure is logged
      // as a warning without masking the successful filing or skipping the
      // remaining confirmation steps.

      // The kvittens is the canonical filing receipt: confirm the period's
      // arbetsgivardeklaration deadline (terminal state).
      try {
        await completeTaxDeadline(
          supabase,
          companyId,
          ['arbetsgivardeklaration'],
          `${decl.period_year}-${String(decl.period_month).padStart(2, '0')}`,
          'confirmed'
        )
      } catch (deadlineErr) {
        console.warn('[agi-kvittenser-cron] completeTaxDeadline failed after successful filing', {
          declarationId, companyId, period,
          message: deadlineErr instanceof Error ? deadlineErr.message : 'Unknown error',
        })
      }

      // Tell the user: signing happened at Skatteverket, often long after
      // they closed our tab, so this is the only confirmation they get.
      if (resolved.tokenUserId) {
        try {
          await sendKvittensNotification(supabase, {
            companyId,
            userId: resolved.tokenUserId,
            kind: 'agi',
            period,
            kvittensnummer: kvittens.uuidKvittens,
            referenceId: declarationId,
          })
        } catch (notifyErr) {
          console.warn('[agi-kvittenser-cron] sendKvittensNotification failed after successful filing', {
            declarationId, companyId, period,
            message: notifyErr instanceof Error ? notifyErr.message : 'Unknown error',
          })
        }
      }

      results.push({ declarationId, companyId, period, status: 'signed' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (err instanceof SkatteverketAuthError && err.code === 'OMBUD_GRANT_MISSING') {
        // System-mode read rejected: the company withdrew the behorighet.
        // Downgrade the connection row so the next run falls back to the
        // user token (if any). Never touches skatteverket_tokens.
        await markGrantRevoked(companyId, currentSkvEnvironment(), 'lasombud', err.code)
        results.push({ declarationId, companyId, period, status: 'grant_revoked', error: err.code })
        continue
      }

      if (
        err instanceof SkatteverketAuthError &&
        (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
      ) {
        // Persist the health flag so both crons stop retrying this
        // connection and the UI can prompt for re-consent proactively.
        const { data: tokenRow } = await supabase
          .from('skatteverket_tokens')
          .select('user_id')
          .eq('company_id', companyId)
          .maybeSingle()
        if (tokenRow?.user_id) {
          await markNeedsReconsent(supabase, tokenRow.user_id as string, err.code)
        }
        results.push({ declarationId, companyId, period, status: 'expired_token', error: err.code })
        continue
      }
      if (err instanceof SkatteverketAuthError && err.code === 'TOKEN_REVOKED') {
        // skvRequest already deleted the token row.
        results.push({ declarationId, companyId, period, status: 'expired_token', error: err.code })
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
        results.push({ declarationId, companyId, period, status: 'apigw_config', error: err.code })
        continue
      }

      console.error('[agi-kvittenser-cron] Reconciliation failed', { declarationId, companyId, period, message })
      results.push({ declarationId, companyId, period, status: 'error', error: message })
    }
  }

  const signed = results.filter(r => r.status === 'signed').length
  const stillPending = results.filter(r => r.status === 'still_pending').length
  const expired = results.filter(r => r.status === 'expired_token').length
  const grantRevoked = results.filter(r => r.status === 'grant_revoked').length
  const apigwConfig = results.filter(r => r.status === 'apigw_config').length
  const errors = results.filter(r => r.status === 'error').length

  console.log(
    `[agi-kvittenser-cron] Processed ${results.length}: ${signed} signed, ${stillPending} still pending, ${expired} expired, ${grantRevoked} grants revoked, ${apigwConfig} apigw config gaps, ${errors} errors`,
  )

  return NextResponse.json({
    processed: results.length,
    signed,
    stillPending,
    expired,
    grantRevoked,
    apigwConfig,
    errors,
    results,
  })
}
