import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { skvRequestWithAuth, SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'
import { resolveReadAuth, currentSkvEnvironment } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { markGrantRevoked } from '@/extensions/general/skatteverket/lib/connection-store'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { SkatteverketInlamnatResponse } from '@/extensions/general/skatteverket/types'
import type { VatPeriodType } from '@/types'

ensureInitialized()

export const maxDuration = 60

/**
 * GET /api/extensions/skatteverket/vat/kvittenser/cron
 *
 * VAT filing reconciliation, mirroring the AGI kvittens cron. A locked VAT
 * draft (`submission_{period}` extension_data row with status
 * 'draft_locked') means the user was handed a BankID signing link at
 * Skatteverket. If they sign and never come back to the panel, nothing on
 * our side records that the declaration was filed: the submission state
 * stays "awaiting signature", the moms deadline stays open, and the user
 * gets no confirmation. This cron polls /inlamnat for those periods and on
 * a hit flips the stored state to 'signed', completes the period's moms
 * deadline, and emails the filing confirmation.
 *
 * Per-row errors are logged and skipped: one expired token must not block
 * other companies' reconciliation.
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

  // AGI submission state uses the distinct `agi_submission_` prefix, so the
  // `submission_` filter below cannot match AGI rows.
  const { data: rows, error: rowsError } = await supabase
    .from('extension_data')
    .select('company_id, key, value')
    .eq('extension_id', 'skatteverket')
    .like('key', 'submission\\_%')
    .order('updated_at', { ascending: true })
    .limit(200)

  if (rowsError) {
    console.error('[vat-kvittenser-cron] Failed to fetch submission states', {
      message: rowsError.message,
      code: rowsError.code,
    })
    return NextResponse.json({ error: 'Failed to fetch submission states' }, { status: 500 })
  }

  interface SubmissionState {
    status?: string
    redovisare?: string
    redovisningsperiod?: string
    periodType?: VatPeriodType
    year?: number
    period?: number
    signeringsLank?: string
    updatedAt?: string
  }

  const locked = (rows ?? []).flatMap((row) => {
    try {
      const state: SubmissionState =
        typeof row.value === 'string' ? JSON.parse(row.value) : (row.value as SubmissionState)
      if (state?.status !== 'draft_locked' || !state.redovisare || !state.redovisningsperiod) {
        return []
      }
      return [{ companyId: row.company_id as string, key: row.key as string, state }]
    } catch {
      return []
    }
  })

  if (locked.length === 0) {
    return NextResponse.json({ message: 'No locked drafts', processed: 0 })
  }

  const startTime = Date.now()
  const TIME_BUDGET_MS = 50_000

  type Result = {
    companyId: string
    period: string
    status: 'signed' | 'still_pending' | 'no_token' | 'expired_token' | 'error'
    error?: string
  }
  const results: Result[] = []

  for (const item of locked) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      console.log(`[vat-kvittenser-cron] Time budget reached after ${results.length} rows`)
      break
    }

    const { companyId, key, state } = item
    const period = state.redovisningsperiod as string

    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      continue
    }

    try {
      // Prefers system credentials (verified moms_ombud grant), falls back
      // to the company's user token: post-signing checks are exactly where
      // the 65-minute personal session is usually already dead.
      const resolved = await resolveReadAuth(supabase, companyId, { requires: 'moms_ombud' })
      if (!resolved.ok) {
        if (resolved.reason === 'needs_reconsent') {
          results.push({ companyId, period, status: 'expired_token', error: 'needs_reconsent' })
        } else {
          results.push({ companyId, period, status: 'no_token' })
        }
        continue
      }

      const response = await skvRequestWithAuth(
        resolved.auth,
        'GET',
        `/inlamnat/${state.redovisare}/${period}`
      )

      if (response.status === 404) {
        results.push({ companyId, period, status: 'still_pending' })
        continue
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        results.push({ companyId, period, status: 'error', error: `${response.status}: ${text}` })
        continue
      }

      const inlamnat = (await response.json()) as SkatteverketInlamnatResponse

      // Flip the stored state so the panel shows "inlämnad" instead of a
      // stale "awaiting signature" view. Keep the row (unlike AGI, the VAT
      // panel reads it for kvittens display on revisit).
      const { error: updateError } = await supabase
        .from('extension_data')
        .update({
          value: JSON.stringify({
            ...state,
            status: 'signed',
            kvittensnummer: inlamnat.kvittensnummer ?? null,
            tidpunkt: inlamnat.tidpunkt ?? null,
            updatedAt: new Date().toISOString(),
          }),
        })
        .eq('company_id', companyId)
        .eq('extension_id', 'skatteverket')
        .eq('key', key)

      if (updateError) {
        // The row is still draft_locked, so the next run retries it. Skip
        // the deadline completion and the notification: doing them now
        // would double-fire when the retry succeeds.
        console.error('[vat-kvittenser-cron] Failed to persist signed state', {
          companyId,
          period,
          message: updateError.message,
          code: updateError.code,
        })
        results.push({
          companyId,
          period,
          status: 'error',
          error: `Failed to persist signed state: ${updateError.message}`,
        })
        continue
      }

      // Complete the period's moms deadline. Only possible when the state
      // carries the picker params (written by the one-click chain; states
      // persisted by the older step-by-step routes lack them).
      if (state.periodType && state.year && state.period) {
        const taxPeriod =
          state.periodType === 'monthly'
            ? `${state.year}-${String(state.period).padStart(2, '0')}`
            : state.periodType === 'quarterly'
              ? `${state.year}-Q${state.period}`
              : null
        if (taxPeriod) {
          await completeTaxDeadline(
            supabase,
            companyId,
            ['moms_monthly', 'moms_quarterly'],
            taxPeriod,
            'confirmed'
          )
        }
      }

      if (resolved.tokenUserId) {
        await sendKvittensNotification(supabase, {
          companyId,
          userId: resolved.tokenUserId,
          kind: 'vat',
          period,
          kvittensnummer: inlamnat.kvittensnummer ?? period,
          referenceId: `vat_${companyId}_${period}`,
        })
      }

      results.push({ companyId, period, status: 'signed' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (err instanceof SkatteverketAuthError && err.code === 'OMBUD_GRANT_MISSING') {
        // System-mode read rejected: downgrade the connection row so the
        // next run falls back to the user token (if any). Best-effort: a
        // failure here must not abort the remaining companies' rows.
        try {
          await markGrantRevoked(companyId, currentSkvEnvironment(), 'moms_ombud', err.code)
        } catch (revokeErr) {
          console.warn('[vat-kvittenser-cron] Failed to mark grant revoked', {
            companyId,
            period,
            message: revokeErr instanceof Error ? revokeErr.message : 'Unknown error',
          })
        }
        results.push({ companyId, period, status: 'error', error: err.code })
        continue
      }

      if (
        err instanceof SkatteverketAuthError &&
        (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
      ) {
        // Persist the health flag so the cron stops retrying this
        // connection. Best-effort: a failure here must not abort the
        // remaining companies' rows.
        try {
          const { data: tokenRow } = await supabase
            .from('skatteverket_tokens')
            .select('user_id')
            .eq('company_id', companyId)
            .maybeSingle()
          if (tokenRow?.user_id) {
            await markNeedsReconsent(supabase, tokenRow.user_id as string, err.code)
          }
        } catch (reconsentErr) {
          console.warn('[vat-kvittenser-cron] Failed to persist reconsent flag', {
            companyId,
            period,
            message: reconsentErr instanceof Error ? reconsentErr.message : 'Unknown error',
          })
        }
        results.push({ companyId, period, status: 'expired_token', error: err.code })
        continue
      }
      if (err instanceof SkatteverketAuthError) {
        results.push({ companyId, period, status: 'expired_token', error: err.code })
        continue
      }

      console.error('[vat-kvittenser-cron] Reconciliation failed', { companyId, period, message })
      results.push({ companyId, period, status: 'error', error: message })
    }
  }

  const signed = results.filter((r) => r.status === 'signed').length
  const stillPending = results.filter((r) => r.status === 'still_pending').length
  const expired = results.filter((r) => r.status === 'expired_token').length
  const errors = results.filter((r) => r.status === 'error').length

  console.log(
    `[vat-kvittenser-cron] Processed ${results.length}: ${signed} signed, ${stillPending} still pending, ${expired} expired, ${errors} errors`
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
