/**
 * Which assets the per-unit engine (component-depreciation.ts) plans, and
 * the unit a plain asset is to it. Pure.
 *
 * The asset-level linear paths in depreciation-engine.ts plan from the
 * acquisition date and know nothing of write-downs. An asset the register
 * has more to say about goes through the unit engine instead, as a K3
 * component asset already does:
 *   - K3 components (17.4);
 *   - mark (category 'land'), never depreciated;
 *   - a depreciation start after the acquisition date (K3 17.18);
 *   - a posted nedskrivning or reversal (ÅRL 4:5, K3 27): what is left after
 *     it is spread over the remaining life (K3 27.15 kommentar).
 * For any other asset the unit engine and the asset-level path give the
 * same charge, so the dispatch only moves the assets that need it.
 */
import { roundOre } from '@/lib/money'
import type { DepreciationUnit } from './component-depreciation'
import { hasComponents, planAnchor } from './component-depreciation'
import { effectiveAdjustments } from './value-adjustments'
import type { Asset } from '@/types'

export function isLand(asset: Pick<Asset, 'category'>): boolean {
  return asset.category === 'land'
}

/** The day depreciation starts: the start date (K3 17.18), else the acquisition date. */
export function depreciationStartOf(asset: Pick<Asset, 'acquisition_date' | 'depreciation_start_date'>): string {
  return asset.depreciation_start_date && asset.depreciation_start_date > asset.acquisition_date
    ? asset.depreciation_start_date
    : asset.acquisition_date
}

/** True when the asset is planned by the unit engine (see the module comment). */
export function usesUnitEngine(
  asset: Pick<
    Asset,
    'acquisition_date' | 'k3_components' | 'components' | 'category' | 'depreciation_start_date' | 'value_adjustments'
  >,
): boolean {
  return (
    hasComponents(asset) ||
    isLand(asset) ||
    depreciationStartOf(asset) !== asset.acquisition_date ||
    effectiveAdjustments(asset).length > 0
  )
}

/** A plain asset's history before a period, as the unit engine reads it. */
export interface PlainAssetHistory {
  /** Planenlig avskrivning posted in Accounted before the period. */
  posted: number
  /** Net write-down dated before the period. */
  writtenDown: number
  /** historyCompleteFrom for the unit's anchor. */
  isComplete: (anchor: string) => boolean
}

/** A plain (non-component) asset as one depreciation unit. */
export function plainAssetUnit(
  asset: Asset,
  history: PlainAssetHistory,
  periodStart: string,
): DepreciationUnit {
  // The asset-level opening (openingDepreciationOf in depreciation-engine,
  // which imports this module).
  const openingAmount = roundOre(Number(asset.opening_accumulated_depreciation ?? 0) || 0)
  const opening =
    openingAmount > 0 && asset.opening_depreciation_date
      ? { amount: openingAmount, date: asset.opening_depreciation_date }
      : null
  const startDate = depreciationStartOf(asset)
  const anchor = planAnchor({ startDate, opening })
  return {
    key: asset.id,
    name: asset.name,
    cost: roundOre(Number(asset.acquisition_cost)),
    salvage: roundOre(Number(asset.salvage_value ?? 0)),
    usefulLifeMonths: isLand(asset) || !(asset.useful_life_months > 0) ? null : asset.useful_life_months,
    startDate,
    opening,
    postedBefore: roundOre(history.posted),
    writtenDownBefore: roundOre(history.writtenDown),
    revaluedBefore: 0,
    endDate: asset.disposed_at ?? null,
    historyComplete: anchor >= periodStart || history.isComplete(anchor),
  }
}
