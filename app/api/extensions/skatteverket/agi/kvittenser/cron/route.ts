import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { agiGetKvittenser } from '@/extensions/general/skatteverket/lib/agi-client'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'
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
    status: 'signed' | 'still_pending' | 'no_token' | 'no_company_settings' | 'expired_token' | 'error'
    error?: string
  }
  const results: Result[] = []

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
      // The token table is user-scoped (one BankID identity per user) but
      // also carries company_id. Match on company_id so a multi-company
      // operator's token is reused only for the company that owns the AGI.
      const { data: token } = await supabase
        .from('skatteverket_tokens')
        .select('user_id')
        .eq('company_id', companyId)
        .maybeSingle()

      if (!token?.user_id) {
        results.push({ declarationId, companyId, period, status: 'no_token' })
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

      const kvittRes = await agiGetKvittenser(supabase, token.user_id as string, arbetsgivare, period)
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
          submitted_by: token.user_id,
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

      results.push({ declarationId, companyId, period, status: 'signed' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (
        err instanceof SkatteverketAuthError &&
        (err.code === 'REFRESH_EXHAUSTED' || err.code === 'SESSION_EXPIRED' || err.code === 'TOKEN_CORRUPTED' || err.code === 'MISSING_SCOPE')
      ) {
        results.push({ declarationId, companyId, period, status: 'expired_token', error: err.code })
        continue
      }

      console.error('[agi-kvittenser-cron] Reconciliation failed', { declarationId, companyId, period, message })
      results.push({ declarationId, companyId, period, status: 'error', error: message })
    }
  }

  const signed = results.filter(r => r.status === 'signed').length
  const stillPending = results.filter(r => r.status === 'still_pending').length
  const expired = results.filter(r => r.status === 'expired_token').length
  const errors = results.filter(r => r.status === 'error').length

  console.log(
    `[agi-kvittenser-cron] Processed ${results.length}: ${signed} signed, ${stillPending} still pending, ${expired} expired, ${errors} errors`,
  )

  return NextResponse.json({
    processed: results.length,
    signed,
    stillPending,
    expired,
    errors,
    results,
  })
}
