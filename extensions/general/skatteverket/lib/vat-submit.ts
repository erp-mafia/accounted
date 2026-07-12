/**
 * Shared VAT "skicka för signering" chain: (kontrollera) -> POST /utkast ->
 * PUT /las -> signeringslänk.
 *
 * Two callers file through this module so they can never drift apart:
 *   - the one-click extension route `POST /declaration/submit` (index.ts),
 *     which runs the kontrollera pre-step so a declaration with validation
 *     errors is stopped before anything is written to Eget utrymme
 *   - the pending-operations commit service `commitSubmitVatDeclaration`
 *     (index.ts), where the staged figures were already reviewed and the
 *     chain starts at the utkast write
 *
 * The momsuppgift is recomputed here via buildMomsuppgift (recompute-at-
 * commit): the figures filed always equal what the preview showed for the
 * same ledger state.
 *
 * SkatteverketAuthError propagates to the caller: the route maps it through
 * handleSkvError, the commit service through mapServiceError.
 */
import type { ExtensionContext } from '@/lib/extensions/types'
import type { VatPeriodType } from '@/types'
import { skvRequest } from './api-client'
import { writeSkatteverketAudit } from './audit'
import { buildMomsuppgift } from './declaration-prep'
import type { SkatteverketKontroll, SkatteverketKontrollResultat, SkatteverketUtkastResponse } from '../types'

export interface VatSubmitChainParams {
  periodType: VatPeriodType
  year: number
  period: number
}

export type VatSubmitChainResult =
  | {
      ok: true
      signingUrl: string
      redovisare: string
      redovisningsperiod: string
      kontrollresultat: SkatteverketKontrollResultat | null
    }
  | {
      ok: false
      /**
       * Where the chain stopped. `validation` failures happen before any
       * write at Skatteverket; `draft` failures leave nothing worth keeping
       * (utkast overwrites, so retrying the whole chain is safe); `lock`
       * failures leave a saved draft in Eget utrymme (`draftSaved: true`),
       * so the retry only needs the lock step.
       */
      stage: 'validation' | 'draft' | 'lock'
      httpStatus: number
      error: string
      kontrollresultat: SkatteverketKontrollResultat | null
      draftSaved: boolean
    }

export async function submitVatDeclarationChain(
  ctx: ExtensionContext,
  params: VatSubmitChainParams,
  options: { validate?: boolean } = {}
): Promise<VatSubmitChainResult> {
  const { supabase, userId } = ctx
  const { redovisare, redovisningsperiod, momsuppgift } =
    await buildMomsuppgift(supabase, ctx.companyId, params)

  // 0. Optional kontrollera pre-step: SKV validates the arithmetic without
  //    saving anything. ERROR-level findings abort the chain here, before
  //    any state exists at Skatteverket.
  if (options.validate) {
    const kontrollera = await skvRequest(
      supabase, userId, 'POST', `/kontrollera/${redovisare}/${redovisningsperiod}`, momsuppgift,
    )
    await writeSkatteverketAudit(ctx, {
      endpoint: 'declaration/validate', agRegistreradId: redovisare, redovisningsperiod,
      outcome: kontrollera.ok ? 'ok' : 'skv_error', responseStatus: kontrollera.status,
    })
    if (!kontrollera.ok) {
      const text = await kontrollera.text().catch(() => '')
      return {
        ok: false, stage: 'validation', httpStatus: kontrollera.status,
        error: `Skatteverket svarade med ${kontrollera.status}: ${text}`,
        kontrollresultat: null, draftSaved: false,
      }
    }
    const kontrolleraData = (await kontrollera.json()) as SkatteverketUtkastResponse
    const findings: SkatteverketKontroll[] = kontrolleraData.kontrollResultat?.resultat ?? []
    const errorCount = findings.filter((k) => k.status === 'ERROR').length
    if (errorCount > 0) {
      return {
        ok: false, stage: 'validation', httpStatus: 422,
        error: `Skatteverket hittade ${errorCount} valideringsfel i deklarationen.`,
        kontrollresultat: kontrolleraData.kontrollResultat ?? null, draftSaved: false,
      }
    }
  }

  // 1. POST /utkast: save the draft to Eget utrymme. Overwrites any prior
  //    draft for the period, so retry after a mid-chain failure is safe.
  const utkast = await skvRequest(
    supabase, userId, 'POST', `/utkast/${redovisare}/${redovisningsperiod}`, momsuppgift,
  )
  await writeSkatteverketAudit(ctx, {
    endpoint: 'declaration/draft', agRegistreradId: redovisare, redovisningsperiod,
    outcome: utkast.ok ? 'ok' : 'skv_error', responseStatus: utkast.status,
  })
  if (!utkast.ok) {
    const text = await utkast.text().catch(() => '')
    return {
      ok: false, stage: 'draft', httpStatus: utkast.status,
      error: `Skatteverket svarade med ${utkast.status}: ${text}`,
      kontrollresultat: null, draftSaved: false,
    }
  }
  const utkastData = (await utkast.json()) as SkatteverketUtkastResponse

  // periodType/year/period ride along so the VAT kvittens cron can complete
  // the period's moms deadline without reverse-parsing redovisningsperiod.
  await ctx.settings.set(
    `submission_${redovisningsperiod}`,
    JSON.stringify({
      status: 'draft_saved', redovisare, redovisningsperiod,
      periodType: params.periodType, year: params.year, period: params.period,
      kontrollresultat: utkastData.kontrollResultat, updatedAt: new Date().toISOString(),
    }),
  )

  // 2. PUT /las: lock for signing; returns the BankID signeringslänk.
  const las = await skvRequest(
    supabase, userId, 'PUT', `/las/${redovisare}/${redovisningsperiod}`,
  )
  await writeSkatteverketAudit(ctx, {
    endpoint: 'declaration/lock', agRegistreradId: redovisare, redovisningsperiod,
    outcome: las.ok ? 'ok' : 'skv_error', responseStatus: las.status,
  })
  if (!las.ok) {
    const text = await las.text().catch(() => '')
    return {
      ok: false, stage: 'lock', httpStatus: las.status,
      error: `Skatteverket svarade med ${las.status}: ${text}`,
      kontrollresultat: utkastData.kontrollResultat ?? null, draftSaved: true,
    }
  }
  const lasData = (await las.json()) as SkatteverketUtkastResponse
  if (!lasData.signeringsLank) {
    return {
      ok: false, stage: 'lock', httpStatus: 502,
      error: 'Skatteverket låste deklarationen men returnerade ingen signeringslänk.',
      kontrollresultat: utkastData.kontrollResultat ?? null, draftSaved: true,
    }
  }

  // Persist locked state so the UI/poller can resume (mirrors /declaration/lock).
  await ctx.settings.set(
    `submission_${redovisningsperiod}`,
    JSON.stringify({
      status: 'draft_locked', redovisare, redovisningsperiod,
      periodType: params.periodType, year: params.year, period: params.period,
      signeringsLank: lasData.signeringsLank, updatedAt: new Date().toISOString(),
    }),
  )

  return {
    ok: true,
    signingUrl: lasData.signeringsLank,
    redovisare,
    redovisningsperiod,
    kontrollresultat: utkastData.kontrollResultat ?? null,
  }
}
