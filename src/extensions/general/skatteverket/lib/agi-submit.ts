/**
 * Shared AGI "skicka för signering" chain: POST /underlag -> poll
 * kontrollresultat -> skapaGranskningsunderlag(lasPeriod) -> the Mina Sidor
 * signing link. The AGI twin of vat-submit.ts.
 *
 * Two callers file through this module so they can never drift apart:
 *   - the one-click extension route `POST /agi/send-for-signing` (index.ts),
 *     which the AGI panel calls for "Skicka för signering"
 *   - the pending-operations commit service `commitSubmitAgi` (index.ts),
 *     behind MCP gnubok_agi_submit
 * The panel used to run the chain itself across three routes, and those
 * routes flip agi_declarations by period only, so a correction run sharing
 * the period was flipped with it. Here every status flip is scoped by the
 * salary run, with the monotonic guards the commit service already had.
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
import { firstAgiKontrollMessage, summarizeAgiKontrollrapport } from './agi-kontrollrapport'
import { buildAgiUnderlag } from './declaration-prep'

export interface AgiSubmitChainOptions {
  /** Kontrollresultat polls after the first read (Skatteverket is usually sub-second). */
  extraPolls?: number
  pollIntervalMs?: number
}

export type AgiSubmitChainResult =
  | {
      ok: true
      signingUrl: string
      arbetsgivare: string
      period: string
      inlamningId: number
      tillstand: string
    }
  | {
      ok: false
      code: string
      httpStatus: number
      /** true: nothing is wrong with the declaration, try again shortly. */
      recoverable: boolean
      error: string
      details?: Record<string, unknown>
    }

export async function submitAgiChain(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  settings: ExtensionContext['settings'],
  salaryRunId: string,
  options: AgiSubmitChainOptions = {},
): Promise<AgiSubmitChainResult> {
  const { arbetsgivare, period, xml, periodYear, periodMonth } = await buildAgiUnderlag(supabase, companyId, salaryRunId)
  const scope = { agRegistreradId: arbetsgivare, redovisningsperiod: period }
  // Every status flip below names the run: a correction run sharing the
  // period keeps its own (still valid) declaration.
  const declarationOfRun = (status: string, from: string[]) =>
    supabase
      .from('agi_declarations')
      .update({ status })
      .eq('company_id', companyId)
      .eq('salary_run_id', salaryRunId)
      .eq('period_year', periodYear)
      .eq('period_month', periodMonth)
      .in('status', from)

  // 1. POST /underlag (XML) -> inlamningId.
  const submit = await agiPostUnderlag(supabase, userId, companyId, xml, scope)
  if (!submit.ok) {
    return { ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', httpStatus: submit.status, recoverable: false, error: submit.error }
  }
  const inlamningId = submit.data.inlamningId
  await settings.set(
    `agi_submission_${period}`,
    JSON.stringify({ status: 'underlag_submitted', arbetsgivare, period, salaryRunId, inlamningId, updatedAt: new Date().toISOString() }),
  )

  // 2. Poll kontrollresultat (bounded).
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
    await declarationOfRun('rejected', ['generated', 'pending_signature', 'exported'])
    // Skatteverket's kontrollsvar rides along (personnummer masked) so the
    // reader sees which fields were refused, not only that they were.
    const kontrollrapport = summarizeAgiKontrollrapport(kontroll.data)
    const firstError = firstAgiKontrollMessage(kontrollrapport)
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

  // 3. skapaGranskningsunderlag (lasPeriod=true) -> Mina Sidor signing link.
  const gransk = await agiSkapaGranskningsunderlag(supabase, userId, companyId, arbetsgivare, period, { lasPeriod: true })
  if (!gransk.ok) {
    return { ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', httpStatus: gransk.status, recoverable: false, error: gransk.error }
  }
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
    // RECEIVING / CALCULATING and the like: still processing.
    return {
      ok: false,
      code: 'SKATTEVERKET_PROCESSING',
      httpStatus: 202,
      recoverable: true,
      error: gransk.data.meddelande || 'Skatteverket bearbetar fortfarande underlaget. Försök igen om en stund.',
    }
  }

  await declarationOfRun('pending_signature', ['generated', 'rejected'])
  return { ok: true, signingUrl: gransk.data.link, arbetsgivare, period, inlamningId, tillstand }
}
