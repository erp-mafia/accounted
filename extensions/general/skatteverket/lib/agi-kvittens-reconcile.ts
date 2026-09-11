import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { formatRedovisare, formatRedovisningsperiod } from '@/lib/skatteverket/format'
import { parseEntityType } from '@/lib/company/entity-type'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { agiGetKvittenser } from './agi-client'
import { resolveReadAuth } from './resolve-auth'
import { sendKvittensNotification } from './kvittens-notification'

/**
 * Shared per-declaration kvittens reconciliation.
 *
 * The user signs the AGI in Skatteverket's Mina Sidor; the resulting kvittens
 * (uuidKvittens + signeradTid) is the canonical filing receipt. This module
 * turns a `pending_signature` agi_declarations row into `submitted` once that
 * kvittens exists: it is called from the nightly kvittens cron and from the
 * post-connect refresh (right after a fresh BankID consent, the one moment a
 * personal token is guaranteed alive).
 *
 * Auth errors (SkatteverketAuthError) propagate to the caller on purpose: the
 * cron maps them to per-run statuses and side effects (needs_reconsent
 * flagging, grant revocation) that differ from the post-connect path.
 *
 * Logging goes through the structured logger (redaction + level filtering);
 * the cron tests observe it via a logger mock.
 */

const log = createLogger('agi-kvittens-reconcile')

export interface PendingAgiDeclaration {
  id: string
  company_id: string
  salary_run_id: string | null
  period_year: number
  period_month: number
}

export type AgiReconcileOutcome =
  | { status: 'signed'; kvittensnummer: string }
  | { status: 'still_pending' }
  /** Another run (cron vs post-connect) promoted the row first; no side effects ran. */
  | { status: 'already_claimed' }
  | { status: 'no_token' }
  | { status: 'expired_token'; error: string }
  | { status: 'no_company_settings' }
  | { status: 'error'; error: string }

export async function reconcileAgiDeclaration(
  supabase: SupabaseClient,
  decl: PendingAgiDeclaration,
  opts: { reconciledBy: 'cron' | 'post-connect'; userId?: string },
): Promise<AgiReconcileOutcome> {
  const companyId = decl.company_id
  const declarationId = decl.id
  const period = formatRedovisningsperiod('monthly', decl.period_year, decl.period_month)

  // Auth resolution prefers system credentials (verified lasombud grant)
  // and falls back to the company's user token: kvittens polling is the
  // canonical case for the hybrid model, since the user signed at SKV
  // and their 65-minute session is usually long dead by the time the
  // kvittens exists.
  const resolved = await resolveReadAuth(supabase, companyId, {
    requires: 'lasombud',
    userId: opts.userId,
  })
  if (!resolved.ok) {
    if (resolved.reason === 'needs_reconsent') {
      // A connection flagged needs_reconsent cannot heal on its own
      // (SKV's per-flow refresh tokens live 65 minutes): skip quietly
      // instead of failing the same declaration every run.
      return { status: 'expired_token', error: 'needs_reconsent' }
    }
    return { status: 'no_token' }
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', companyId)
    .single()

  if (!settings?.org_number) {
    return { status: 'no_company_settings' }
  }

  const arbetsgivare = formatRedovisare(
    settings.org_number as string,
    parseEntityType(settings.entity_type),
  )

  const kvittRes = await agiGetKvittenser(resolved.auth, arbetsgivare, period)
  if (!kvittRes.ok) {
    return { status: 'error', error: kvittRes.error }
  }

  const kvittens = kvittRes.data.kvittenser?.[0]
  if (!kvittens?.uuidKvittens) {
    return { status: 'still_pending' }
  }

  // The presence of uuidKvittens confirms SKV signed and accepted
  // the AGI. signeradTid is the precise signing moment; if SKV omits
  // it we fall back to reconciliation time + warn so the discrepancy
  // is investigable. Leaving NULL would hide that the filing occurred
  // at all, which itself misstates behandlingshistorik (BFNAR 2013:2
  // kap 8 / BFL 5 kap 6§). The fallback only applies on this code
  // path because we're inside the kvittens-found branch above.
  // The fallback is an upper bound (reconciliation ran after signing)
  // recorded to keep behandlingshistorik complete; response_data.signeradTid
  // stays null and submittedAtEstimated=true marks the estimate so it is
  // never mistaken for the legal filing time.
  const submittedAt = kvittens.signeradTid || new Date().toISOString()
  if (!kvittens.signeradTid) {
    log.warn('kvittens missing signeradTid; using reconciliation time', {
      declarationId, companyId, period,
    })
  }

  // submitted_by records the TECHNICAL submitter: the token-owning
  // auth.users row, i.e. the human who connected via BankID. The LEGAL
  // signatory is response_data.signeradAv from the kvittens (a
  // personnummer), which the token user_id does NOT necessarily match
  // (e.g. if the connected user is a bookkeeper but the
  // deklarationsombud signed). signeradAv is the authoritative
  // reference for the audit trail (BFL 5 kap 6§, BFNAR 2013:2 kap 8);
  // we preserve the full kvittens in response_data so it records the
  // actual BankID signer regardless of who triggered the reconciliation.
  // Compare-and-set claim: the 2-hourly cron and a post-connect refresh can
  // race on the same declaration, and the side effects below (salary_runs
  // stamp, cache cleanup, deadline confirmation, notification) must run
  // exactly once. Zero updated rows means another run won the claim; a
  // failed update must not fall through to those side effects either.
  const { data: claimed, error: claimError } = await supabase
    .from('agi_declarations')
    .update({
      status: 'submitted',
      kvittensnummer: kvittens.uuidKvittens,
      submitted_at: submittedAt,
      submitted_by: resolved.tokenUserId,
      response_data: {
        signeradAv: kvittens.signeradAv ?? null,
        signeradTid: kvittens.signeradTid ?? null,
        submittedAtEstimated: !kvittens.signeradTid,
        uuidKvittens: kvittens.uuidKvittens,
        arbetsgivare: kvittens.arbetsgivare ?? null,
        period: kvittens.period ?? null,
        underlag: kvittens.underlag ?? null,
        reconciledBy: opts.reconciledBy,
      },
    })
    .eq('id', declarationId)
    .eq('company_id', companyId)
    .eq('status', 'pending_signature')
    .select('id')

  if (claimError) {
    return { status: 'error', error: `Kunde inte uppdatera deklarationen: ${claimError.message}` }
  }
  if (!claimed || claimed.length === 0) {
    return { status: 'already_claimed' }
  }

  if (decl.salary_run_id) {
    const { error: runError } = await supabase
      .from('salary_runs')
      .update({ agi_submitted_at: submittedAt })
      .eq('id', decl.salary_run_id)
      .eq('company_id', companyId)
    if (runError) {
      // The declaration is already promoted and cannot be unwound here; a
      // missing agi_submitted_at stamp must stay investigable (BFNAR 2013:2
      // kap 8 behandlingshistorik) without aborting the remaining steps.
      log.warn('salary_runs agi_submitted_at stamp failed after claim', {
        declarationId, companyId, period,
        message: runError.message,
      })
    }
  }

  // Clear the locally-cached submission state so the panel doesn't
  // pop a stale "awaiting signature" view if the user revisits.
  // No declaration-id guard is needed here: the cache key is
  // deliberately period-scoped and agi_declarations is UNIQUE per
  // company+period, so no two declarations share a key and there is
  // no cross-declaration race to guard.
  await supabase
    .from('extension_data')
    .delete()
    .eq('company_id', companyId)
    .eq('extension_id', 'skatteverket')
    .eq('key', `agi_submission_${period}`)

  // The declaration is already flipped to submitted above, and reconciliation
  // only revisits pending_signature rows: from here on everything is
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
    log.warn('completeTaxDeadline failed after successful filing', {
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
      log.warn('sendKvittensNotification failed after successful filing', {
        declarationId, companyId, period,
        message: notifyErr instanceof Error ? notifyErr.message : 'Unknown error',
      })
    }
  }

  return { status: 'signed', kvittensnummer: kvittens.uuidKvittens }
}
