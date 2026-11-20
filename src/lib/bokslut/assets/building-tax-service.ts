/**
 * The INK2S 4.9 adjustment for one fiscal year, read from the register:
 * the year's posted depreciation and net write-down on buildings,
 * markanläggningar and mark against each asset's tax plan
 * (building-tax.ts). Read by the INK2 declaration and by the bolagsskatt
 * computation, so the tax booked and the tax declared agree.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { chunk } from '@/lib/utils'
import { AssetNotFoundError, getAsset, listAssets } from './asset-service'
import {
  buildingTaxAdjustment,
  isTaxRealProperty,
  taxPlanForYear,
  taxValueAt,
  type BuildingTaxAdjustment,
} from './building-tax'
import { addDaysIso } from './plan-calendar'
import { loadCarryingAmountsAt } from './register-carrying-amounts'
import { effectiveAdjustments } from './value-adjustments'
import type { Asset, FiscalPeriod } from '@/types'

export async function loadBuildingTaxAdjustment(
  supabase: SupabaseClient,
  companyId: string,
  period: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>,
): Promise<BuildingTaxAdjustment> {
  const assets = (await listAssets(supabase, companyId)).filter(
    (asset) => isTaxRealProperty(asset) && !(asset.disposed_at && asset.disposed_at < period.period_start),
  )
  if (assets.length === 0) return { net: 0, lines: [], warnings: [] }

  const schedules = (
    await Promise.all(
      chunk(assets.map((asset) => asset.id), 200).map((ids) =>
        fetchAllRows<{ id: string; asset_id: string; planned_depreciation: number | string }>(({ from, to }) =>
          supabase
            .from('depreciation_schedules')
            .select('id, asset_id, planned_depreciation')
            .eq('company_id', companyId)
            .eq('fiscal_period_id', period.id)
            .in('asset_id', ids)
            .not('journal_entry_id', 'is', null)
            .order('id', { ascending: true })
            .range(from, to),
        ),
      ),
    )
  ).flat()
  const depreciation = new Map<string, number>()
  for (const row of schedules) {
    depreciation.set(row.asset_id, roundOre((depreciation.get(row.asset_id) ?? 0) + (Number(row.planned_depreciation) || 0)))
  }

  return buildingTaxAdjustment(
    assets.map((asset) => {
      const writtenDown = effectiveAdjustments(asset)
        .filter((row) => row.adjustment_date >= period.period_start && row.adjustment_date <= period.period_end)
        .reduce((sum, row) => sum + (row.kind === 'impairment' ? 1 : -1) * (Number(row.amount) || 0), 0)
      return { asset, book: roundOre((depreciation.get(asset.id) ?? 0) + writtenDown) }
    }),
    period,
  )
}

/** A building's carrying amount and tax value at the balansdag (K3 29.14). */
export interface BuildingTemporaryDifference {
  assetId: string
  name: string
  carryingAmount: number
  taxValue: number
}

/**
 * The temporary differences of the buildings and markanläggningar with a
 * tax plan, for the K3 deferred tax: the carrying amount at the balansdag
 * (carryingAmountAt: per component for a component asset) against the tax
 * value (mark at cost, the rest on its tax plan). Assets without a tax plan
 * are left out: their tax value is not known.
 */
export async function loadBuildingTemporaryDifferences(
  supabase: SupabaseClient,
  companyId: string,
  period: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>,
  /** The first day of the fiscal year the figures belong to, for which plans reach it (default period_start). */
  options: { yearStart?: string } = {},
): Promise<BuildingTemporaryDifference[]> {
  const yearStart = options.yearStart ?? period.period_start
  const assets = (await listAssets(supabase, companyId)).filter(
    (asset) =>
      isTaxRealProperty(asset) &&
      asset.acquisition_date <= period.period_end &&
      !(asset.disposed_at && asset.disposed_at <= period.period_end) &&
      taxPlanForYear(asset, yearStart) !== null,
  )
  if (assets.length === 0) return []
  const carrying = await loadCarryingAmountsAt(supabase, companyId, assets, period.period_end)
  return assets.map((asset) => {
    const plan = taxPlanForYear(asset, yearStart)!
    const cost = roundOre(Number(asset.acquisition_cost))
    return {
      assetId: asset.id,
      name: asset.name,
      carryingAmount: carrying.get(asset.id) ?? 0,
      // The mark part is held at cost for tax as in the books.
      taxValue: roundOre(cost - plan.basis + taxValueAt(plan, period.period_end)),
    }
  })
}

export const TaxPlanSchema = z
  .object({
    tax_depreciation_rate: z.number().gt(0).max(100).nullable(),
    tax_depreciation_from: z.string().regex(ISO_DATE_RE).nullable().optional(),
    tax_primary_allowance: z.boolean().optional(),
  })
  .strict()

export type TaxPlanInput = z.infer<typeof TaxPlanSchema>

/** A tax plan the asset cannot carry (400 INVALID_TAX_PLAN), with the Swedish reason. */
export class AssetTaxPlanInvalidError extends Error {
  readonly code = 'INVALID_TAX_PLAN'
  constructor(message: string) {
    super(message)
    this.name = 'AssetTaxPlanInvalidError'
  }
}

/** A tax plan a closed or locked year was declared with (409 TAX_PLAN_USED_BY_CLOSED_YEAR). */
export class AssetTaxPlanLockedError extends Error {
  readonly code = 'TAX_PLAN_USED_BY_CLOSED_YEAR'
  constructor() {
    super(
      'Den skattemässiga avskrivningsplanen har använts för ett räkenskapsår som är stängt eller låst, och det årets deklaration (INK2S 4.9) får inte ändras i efterhand. Planen kan därför inte ändras eller tas bort här.',
    )
    this.name = 'AssetTaxPlanLockedError'
  }
}

/**
 * The first day a plan stated now reaches: the day after the last fiscal
 * year that is closed, locked or behind the company lock date, or null when
 * no year is. The database sets tax_plan_applies_from by the same rule
 * (set_asset_tax_plan_applies_from); read here for a dry run, which writes
 * nothing.
 */
async function taxPlanReachesFrom(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const [{ data: periods, error }, { data: settings, error: settingsError }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_end, is_closed, locked_at, closing_entry_id')
      .eq('company_id', companyId),
    supabase.from('company_settings').select('bookkeeping_locked_through').eq('company_id', companyId).maybeSingle(),
  ])
  if (error) throw new Error(`Kunde inte läsa räkenskapsåren: ${error.message}`)
  if (settingsError) throw new Error(`Kunde inte läsa låsdatumet: ${settingsError.message}`)
  const lock = (settings as { bookkeeping_locked_through?: string | null } | null)?.bookkeeping_locked_through ?? null
  const done = ((periods ?? []) as Array<{ period_end: string; is_closed: boolean; locked_at: string | null; closing_entry_id: string | null }>)
    .filter((row) => row.is_closed || row.locked_at || row.closing_entry_id || (lock !== null && row.period_end <= lock))
    .map((row) => row.period_end)
    .sort()
  const last = done[done.length - 1]
  return last ? addDaysIso(last, 1) : null
}

/**
 * State a building's or markanläggning's tax plan (IL 19 kap. 5-5 a §§,
 * 20 kap. 5 §). Not part of the book basis. It reaches only fiscal years
 * that are still open when it is stated (tax_plan_applies_from, set by the
 * database), so INK2S 4.9 and the deferred tax of a closed or locked year
 * never move; once a year it reached is closed or locked, the plan is
 * fixed (AssetTaxPlanLockedError).
 */
export async function setAssetTaxPlan(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  input: TaxPlanInput,
  /** dryRun: the same checks; answers the asset as it would read, nothing written. */
  options: { dryRun?: boolean } = {},
): Promise<Asset> {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()
  if (asset.category !== 'building' && asset.category !== 'land_improvement') {
    throw new AssetTaxPlanInvalidError('En skattemässig avskrivningsplan anges för byggnader och markanläggningar (IL 19 och 20 kap.).')
  }
  const rate = input.tax_depreciation_rate
  if (asset.category === 'land_improvement' && rate !== null && rate > 10) {
    throw new AssetTaxPlanInvalidError('En markanläggning skrivs av med högst fem procent per år, tio för täckdiken och skogsvägar (IL 20 kap. 5 §).')
  }
  const from = input.tax_depreciation_from ?? null
  if (from && from < asset.acquisition_date) {
    throw new AssetTaxPlanInvalidError('Den skattemässiga avskrivningen kan inte börja före anskaffningsdatum.')
  }
  const primary = input.tax_primary_allowance === true
  if (primary && asset.category !== 'building') {
    throw new AssetTaxPlanInvalidError('Primäravdrag görs bara för hyreshus (IL 19 kap. 5 a §).')
  }
  const plan = {
    tax_depreciation_rate: rate,
    tax_depreciation_from: rate === null ? null : from,
    tax_primary_allowance: rate === null ? false : primary,
  }
  const unchanged =
    (asset.tax_depreciation_rate === null || asset.tax_depreciation_rate === undefined
      ? null
      : Number(asset.tax_depreciation_rate)) === plan.tax_depreciation_rate &&
    (asset.tax_depreciation_from ?? null) === plan.tax_depreciation_from &&
    (asset.tax_primary_allowance === true) === plan.tax_primary_allowance
  if (unchanged) return asset
  const reachesFrom = await taxPlanReachesFrom(supabase, companyId)
  const appliedFrom = asset.tax_plan_applies_from ?? null
  if (appliedFrom && reachesFrom && appliedFrom < reachesFrom) throw new AssetTaxPlanLockedError()
  if (options.dryRun) {
    return {
      ...asset,
      ...plan,
      tax_plan_applies_from: plan.tax_depreciation_rate === null ? null : reachesFrom ?? appliedFrom ?? asset.acquisition_date,
    }
  }
  const { error } = await supabase
    .from('assets')
    .update({
      tax_depreciation_rate: plan.tax_depreciation_rate,
      tax_depreciation_from: plan.tax_depreciation_from,
      tax_primary_allowance: plan.tax_primary_allowance,
    })
    .eq('id', assetId)
    .eq('company_id', companyId)
  if (error) {
    if (error.message === 'TAX_PLAN_USED_BY_CLOSED_YEAR') throw new AssetTaxPlanLockedError()
    throw new Error(`Kunde inte spara den skattemässiga avskrivningsplanen: ${error.message}`)
  }
  return (await getAsset(supabase, companyId, assetId)) ?? asset
}

