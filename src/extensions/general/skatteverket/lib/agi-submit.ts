/**
 * Shared AGI "skicka för signering" chain: POST /underlag -> poll
 * kontrollresultat -> skapaGranskningsunderlag(lasPeriod) -> the Mina Sidor
 * signing link. The AGI twin of vat-submit.ts.
 *
 * The chain is two steps, exported on their own so every door runs the same
 * code and flips the same rows:
 *   - submitAgiUnderlag: regenerate an unfiled underlag from current data,
 *     POST /underlag, poll kontrollresultat;
 *   - createAgiSigningLink: skapaGranskningsunderlag with the period locked.
 * Callers:
 *   - `POST /agi/send-for-signing` (index.ts), the panel's one-click
 *     "Skicka för signering": submitAgiChain;
 *   - the pending-operations commit service `commitSubmitAgi` (index.ts),
 *     behind MCP gnubok_agi_submit: submitAgiChain;
 *   - `POST /agi/submit` and `POST /agi/granskningsunderlag`, the panel's
 *     advanced recovery buttons: one step each.
 * The panel used to run the chain itself across three routes that flipped
 * agi_declarations by period only, so a correction run sharing the period
 * was flipped with it. Here every status flip is scoped by the salary run,
 * with the monotonic guards the commit service already had.
 *
 * Nothing here files the AGI: filing is the user's BankID signature in Mina
 * Sidor after the lock. The kvittens is recorded later, through the
 * compare-and-set promotion in agi-kvittens-reconcile.ts.
 *
 * SkatteverketAuthError propagates to the caller: the route maps it through
 * handleSkvError, the commit service through mapServiceError. Every SKV call
 * writes its own audit row in the transport ('agi/submit' with outcome 'ok'
 * is read by the migration-reset guard; never relabel it).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionContext } from '@/lib/extensions/types'
import { sleep } from '@/lib/utils'
import { agiGetKontrollresultat, agiPostUnderlag, agiSkapaGranskningsunderlag } from './agi-client'
import { firstAgiKontrollMessage, summarizeAgiKontrollrapport, type AgiKontrollrapportSummary } from './agi-kontrollrapport'
import { buildAgiUnderlag, refreshAgiUnderlag } from './declaration-prep'

export interface AgiSubmitChainOptions {
  /** Kontrollresultat polls after the first read (Skatteverket is usually sub-second). */
  extraPolls?: number
  pollIntervalMs?: number
}

/** Why a step stopped. `recoverable`: nothing is wrong with the declaration, try again shortly. */
export interface AgiStepFailure {
  ok: false
  code: string
  httpStatus: number
  recoverable: boolean
  error: string
  details?: Record<string, unknown>
  /** Skatteverket's own felkod on a refused call, for the route's log line. */
  skvKod?: number
}

/** The run's declaration as Skatteverket addresses it. */
export interface AgiRunTarget {
  salaryRunId: string
  arbetsgivare: string
  period: string
  periodYear: number
  periodMonth: number
}

export type AgiUnderlagStepResult =
  | {
      ok: true
      target: AgiRunTarget
      inlamningId: number
      /** Skatteverket's kontrollsvar on an accepted underlag (warnings), masked; null when it sent none. */
      kontrollrapport: AgiKontrollrapportSummary | null
      /**
       * true when refreshAgiUnderlag replaced the stored XML before the POST:
       * the figures posted differ from the underlag last generated or
       * downloaded, and every door says so.
       */
      underlagRegenerated: boolean
    }
  | AgiStepFailure

export type AgiSigningLinkStepResult =
  | { ok: true; signingUrl: string; tillstand: string }
  | AgiStepFailure

export type AgiSubmitChainResult =
  | {
      ok: true
      signingUrl: string
      arbetsgivare: string
      period: string
      inlamningId: number
      tillstand: string
      /** As on the underlag step: the stored XML was replaced before the POST. */
      underlagRegenerated: boolean
    }
  | AgiStepFailure

/** Flip the run's own declaration, only out of the given statuses. */
function flipRunDeclaration(supabase: SupabaseClient, companyId: string, target: AgiRunTarget, status: string, from: string[]) {
  // Every status flip names the run: a correction run sharing the period
  // keeps its own (still valid) declaration.
  return supabase
    .from('agi_declarations')
    .update({ status })
    .eq('company_id', companyId)
    .eq('salary_run_id', target.salaryRunId)
    .eq('period_year', target.periodYear)
    .eq('period_month', target.periodMonth)
    .in('status', from)
}

/**
 * Step 1: bring the run's underlag up to date (refreshAgiUnderlag: an unfiled
 * declaration is regenerated from current data, so a generator fix reaches
 * an XML stored before it), POST it and poll kontrollresultat until it
 * settles. A refusal at kontroll marks the run's declaration rejected and
 * carries Skatteverket's kontrollsvar. A success says whether the stored
 * XML was replaced (underlagRegenerated).
 */
export async function submitAgiUnderlag(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  settings: ExtensionContext['settings'],
  salaryRunId: string,
  options: AgiSubmitChainOptions = {},
): Promise<AgiUnderlagStepResult> {
  const refreshed = await refreshAgiUnderlag(supabase, companyId, userId, salaryRunId)
  if (!refreshed.ok) {
    // The fresh generation refused (incomplete data, a period conflict, ...):
    // nothing is posted, and never the stale stored XML in its place.
    return {
      ok: false,
      code: refreshed.code,
      httpStatus: refreshed.httpStatus,
      recoverable: false,
      error: refreshed.error,
      ...(refreshed.details ? { details: refreshed.details } : {}),
    }
  }
  const { arbetsgivare, period, xml, periodYear, periodMonth } = await buildAgiUnderlag(supabase, companyId, salaryRunId)
  const target: AgiRunTarget = { salaryRunId, arbetsgivare, period, periodYear, periodMonth }
  const scope = { agRegistreradId: arbetsgivare, redovisningsperiod: period }

  const submit = await agiPostUnderlag(supabase, userId, companyId, xml, scope)
  if (!submit.ok) {
    return {
      ok: false,
      code: 'SKATTEVERKET_SUBMIT_REJECTED',
      httpStatus: submit.status,
      recoverable: false,
      error: submit.error,
      ...(submit.body?.kod ? { skvKod: submit.body.kod } : {}),
    }
  }
  const inlamningId = submit.data.inlamningId
  await settings.set(
    `agi_submission_${period}`,
    JSON.stringify({ status: 'underlag_submitted', arbetsgivare, period, salaryRunId, inlamningId, updatedAt: new Date().toISOString() }),
  )

  const extraPolls = options.extraPolls ?? 2
  const interval = options.pollIntervalMs ?? 750
  let kontroll = await agiGetKontrollresultat(supabase, userId, companyId, inlamningId, scope)
  for (let i = 0; i < extraPolls && kontroll.ok && kontroll.data.status === 'PROCESSING'; i++) {
    await sleep(interval)
    kontroll = await agiGetKontrollresultat(supabase, userId, companyId, inlamningId, scope)
  }
  if (!kontroll.ok) {
    return { ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', httpStatus: kontroll.status, recoverable: false, error: kontroll.error }
  }
  if (kontroll.data.status === 'PROCESSING') {
    return {
      ok: false,
      code: 'SKATTEVERKET_PROCESSING',
      httpStatus: 202,
      recoverable: true,
      error: 'Skatteverket bearbetar fortfarande AGI-underlaget. Försök igen om en stund.',
    }
  }
  if (kontroll.data.status === 'DONE_REJECTED' || kontroll.data.status === 'DONE_FAILED') {
    // Nothing landed in Eget utrymme: the declaration must not sit at
    // 'generated' while Skatteverket's own state shows it failed.
    await flipRunDeclaration(supabase, companyId, target, 'rejected', ['generated', 'pending_signature', 'exported'])
    // Skatteverket's kontrollsvar rides along (personnummer masked) so the
    // reader sees which fields were refused, not only that they were.
    const kontrollrapport = summarizeAgiKontrollrapport(kontroll.data)
    const firstError = firstAgiKontrollMessage(kontrollrapport)
    // The period record has said underlag_submitted since the POST above.
    // Left there, the panel offered the granskningsunderlag step for an
    // underlag Skatteverket refused (PH 217): record the refusal instead.
    await settings.set(
      `agi_submission_${period}`,
      JSON.stringify({
        status: 'underlag_rejected',
        arbetsgivare,
        period,
        salaryRunId,
        inlamningId,
        meddelande: firstError,
        updatedAt: new Date().toISOString(),
      }),
    )
    return {
      ok: false,
      code: 'AGI_KONTROLL_REJECTED',
      httpStatus: 422,
      recoverable: false,
      error: firstError
        ? `Skatteverket avvisade AGI-underlaget vid kontroll: ${firstError.replace(/[.\s]+$/, '')}. Åtgärda felen och generera om AGI:n.`
        : 'Skatteverket avvisade AGI-underlaget vid kontroll. Åtgärda felen och generera om AGI:n.',
      details: { kontrollrapport: kontrollrapport ?? { kontrollresultat_status: kontroll.data.status } },
    }
  }
  return {
    ok: true,
    target,
    inlamningId,
    kontrollrapport: summarizeAgiKontrollrapport(kontroll.data),
    underlagRegenerated: refreshed.outcome === 'replaced',
  }
}

/**
 * Step 2: skapaGranskningsunderlag with the period locked, the Mina Sidor
 * signing link. Flips the run's declaration to pending_signature once
 * Skatteverket holds a signable draft.
 */
export async function createAgiSigningLink(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  settings: ExtensionContext['settings'],
  target: AgiRunTarget,
): Promise<AgiSigningLinkStepResult> {
  const { arbetsgivare, period } = target
  const gransk = await agiSkapaGranskningsunderlag(supabase, userId, companyId, arbetsgivare, period, { lasPeriod: true })
  if (!gransk.ok) {
    return {
      ok: false,
      code: 'SKATTEVERKET_SUBMIT_REJECTED',
      httpStatus: gransk.status,
      recoverable: false,
      error: gransk.error,
      ...(gransk.body?.kod ? { skvKod: gransk.body.kod } : {}),
    }
  }
  // SKV's tillstand (skapagranskningsunderlagsvar.json): LOCKED_FOR_SIGNING
  // and UNLOCKED can be signed; INCORRECT_DATA carries a felrapport link;
  // RECEIVING, CALCULATING and the like are still processing. Keyed on
  // tillstand alone, never on the HTTP status.
  const tillstand = gransk.data.tillstand
  const canSign = tillstand === 'LOCKED_FOR_SIGNING' || tillstand === 'UNLOCKED'
  await settings.set(
    `agi_submission_${period}`,
    JSON.stringify({
      status: canSign ? 'awaiting_signing' : 'underlag_rejected',
      arbetsgivare,
      period,
      signeringslank: gransk.data.link,
      tillstand,
      meddelande: gransk.data.meddelande,
      updatedAt: new Date().toISOString(),
    }),
  )
  if (tillstand === 'INCORRECT_DATA') {
    return {
      ok: false,
      code: 'AGI_GRANSKNING_INCORRECT',
      httpStatus: 422,
      recoverable: false,
      error: gransk.data.meddelande || 'Skatteverket avvisade granskningsunderlaget. Åtgärda felen och generera om AGI:n.',
    }
  }
  if (!canSign) {
    return {
      ok: false,
      code: 'SKATTEVERKET_PROCESSING',
      httpStatus: 202,
      recoverable: true,
      error: gransk.data.meddelande || 'Skatteverket bearbetar fortfarande underlaget. Försök igen om en stund.',
    }
  }

  await flipRunDeclaration(supabase, companyId, target, 'pending_signature', ['generated', 'rejected'])
  return { ok: true, signingUrl: gransk.data.link, tillstand }
}

/**
 * The run's target for step 2 on its own (the panel's "Skapa signeringslänk"
 * after a step-1 success): the same arbetsgivare and period step 1 posted.
 */
export async function agiRunTarget(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<AgiRunTarget> {
  const { arbetsgivare, period, periodYear, periodMonth } = await buildAgiUnderlag(supabase, companyId, salaryRunId)
  return { salaryRunId, arbetsgivare, period, periodYear, periodMonth }
}

/** Both steps in order: what "Skicka för signering" and MCP approval run. */
export async function submitAgiChain(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  settings: ExtensionContext['settings'],
  salaryRunId: string,
  options: AgiSubmitChainOptions = {},
): Promise<AgiSubmitChainResult> {
  const underlag = await submitAgiUnderlag(supabase, userId, companyId, settings, salaryRunId, options)
  if (!underlag.ok) return underlag
  const link = await createAgiSigningLink(supabase, userId, companyId, settings, underlag.target)
  if (!link.ok) return link
  return {
    ok: true,
    signingUrl: link.signingUrl,
    arbetsgivare: underlag.target.arbetsgivare,
    period: underlag.target.period,
    inlamningId: underlag.inlamningId,
    tillstand: link.tillstand,
    underlagRegenerated: underlag.underlagRegenerated,
  }
}
