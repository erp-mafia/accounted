/**
 * Planenlig avskrivning per K3 component (BFNAR 2012:1 17.4, 17.13), from
 * the component's own history. Pure.
 *
 * Each component is a depreciation unit: its cost less salvage value is
 * written off linearly from the day it can be used (17.18) to the end of its
 * useful life. The charge for a fiscal year is computed prospectively from
 * what is left: the remaining depreciable amount (cost - salvage - opening
 * accumulated depreciation - depreciation already posted - net impairment
 * + revaluation) spread over the remaining life, the year's share by its
 * days in use. A changed useful life or salvage value is therefore applied
 * from the year it is changed (K3 10.9-10.10) and never re-charges what was
 * posted before; the year that reaches the end of the life takes exactly
 * what is left, so whole-krona rounding never strands öre on the component.
 * An unchanged plan reproduces the straight-line charge (the remaining
 * amount over the remaining months is the original annual rate).
 *
 * A component without a useful life (mark, 17.13) is never depreciated. A
 * component derecognised in or before the year had its last charge on the
 * derecognition voucher (17.21A) and is not charged again.
 */
import { roundOre } from '@/lib/money'
import {
  addDaysIso,
  addMonthsIso,
  daysInclusive,
  earlierIso,
  laterIso,
  monthsBetween,
} from './plan-calendar'
import type { Asset, AssetComponent, FiscalPeriod } from '@/types'

type Period = Pick<FiscalPeriod, 'period_start' | 'period_end'>

export interface DepreciationUnit {
  /** The component id (or a synthetic key for a legacy JSONB element). */
  key: string
  name: string
  cost: number
  salvage: number
  /** null: not depreciated. */
  usefulLifeMonths: number | null
  /** First day of depreciation (K3 17.18). */
  startDate: string
  /** Accumulated depreciation before the unit's history in Accounted. */
  opening: { amount: number; date: string } | null
  /** Depreciation posted in Accounted for the unit before this period. */
  postedBefore: number
  /** Net accumulated impairment (impairments less reversals) before this period. */
  writtenDownBefore: number
  /** Accumulated revaluation (uppskrivning, ÅRL 4:6) before this period. */
  revaluedBefore: number
  /** Last day the unit is on the books (disposal), inclusive; null when it stays. */
  endDate: string | null
  /** True when the register holds the unit's whole history from its anchor
   *  (its start, or the day after its opening date) to this period: every
   *  year in between has its depreciation posted in Accounted. Only then is
   *  "what is left" known, so only then is the plan re-spread over the
   *  remaining life and trued up at its end. Otherwise years booked outside
   *  the register would be charged again: the straight-line charge stands,
   *  capped at what is left. */
  historyComplete: boolean
}

export interface UnitCharge {
  amount: number
  proRated: boolean
}

/** The depreciable amount still to be charged at the start of the period. */
export function remainingDepreciable(unit: DepreciationUnit): number {
  return roundOre(
    unit.cost +
      unit.revaluedBefore -
      unit.salvage -
      (unit.opening?.amount ?? 0) -
      unit.postedBefore -
      unit.writtenDownBefore,
  )
}

/** The planenlig avskrivning of one unit for one period (see the module comment). */
export function computeUnitCharge(unit: DepreciationUnit, period: Period): UnitCharge {
  const none = { amount: 0, proRated: false }
  if (unit.usefulLifeMonths === null || unit.usefulLifeMonths <= 0) return none
  const remaining = remainingDepreciable(unit)
  if (remaining <= 0) return none

  const lifeEndExclusive = addMonthsIso(unit.startDate, unit.usefulLifeMonths)
  const lifeLastDay = addDaysIso(lifeEndExclusive, -1)
  const remainingStart = unit.opening
    ? laterIso(addDaysIso(unit.opening.date, 1), unit.startDate)
    : unit.startDate

  const windowStart = laterIso(remainingStart, period.period_start)
  let windowEnd = earlierIso(period.period_end, lifeLastDay)
  if (unit.endDate) windowEnd = earlierIso(windowEnd, unit.endDate)
  if (windowEnd < windowStart) return none

  const fraction = daysInclusive(windowStart, windowEnd) / daysInclusive(period.period_start, period.period_end)
  const proRated = fraction < 0.999
  // The year's months in use: its day share of the fiscal year's length in
  // months (a förlängt or förkortat year counts its own months, K2 10.23
  // kommentar and the same rule under K3).
  const monthsInUse = fraction * monthsBetween(period.period_start, addDaysIso(period.period_end, 1))
  const prospective =
    unit.historyComplete || unit.writtenDownBefore !== 0 || unit.revaluedBefore !== 0

  if (!prospective) {
    // The straight-line plan from the anchor, as booked when the estimates
    // were made, capped at what is left.
    const anchorBase = roundOre(unit.cost - unit.salvage - (unit.opening?.amount ?? 0))
    const anchorMonths = monthsBetween(remainingStart, lifeEndExclusive)
    if (anchorMonths <= 0) return { amount: 0, proRated }
    const planned = Math.round((anchorBase * monthsInUse) / anchorMonths)
    return { amount: roundOre(Math.min(planned, remaining)), proRated }
  }

  if (windowEnd >= lifeLastDay) return { amount: remaining, proRated }
  // What is left over the months left of the life from the window's first day.
  const monthsLeft = monthsBetween(windowStart, lifeEndExclusive)
  if (monthsLeft <= 0) return { amount: remaining, proRated }
  const planned = Math.round((remaining * monthsInUse) / monthsLeft)
  return { amount: roundOre(Math.min(planned, remaining)), proRated }
}

/** The day a unit's plan runs from: its start, or the day after its opening. */
export function planAnchor(unit: Pick<DepreciationUnit, 'startDate' | 'opening'>): string {
  return unit.opening ? laterIso(addDaysIso(unit.opening.date, 1), unit.startDate) : unit.startDate
}

/**
 * Whether the register holds a unit's whole history before `periodStart`:
 * the company's fiscal periods reach back to the anchor, and every period
 * from the one holding the anchor to the one before `periodStart` has the
 * asset's depreciation posted. With nothing before the period (the anchor
 * falls in it), the history is trivially whole.
 */
export function historyCompleteFrom(
  anchor: string,
  periodStart: string,
  periods: ReadonlyArray<Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>>,
  postedPeriodIds: ReadonlySet<string>,
): boolean {
  if (anchor >= periodStart) return true
  const before = [...periods]
    .filter((period) => period.period_start < periodStart && period.period_end >= anchor)
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
  if (before.length === 0 || before[0].period_start > anchor) return false
  for (let index = 0; index < before.length; index++) {
    if (!postedPeriodIds.has(before[index].id)) return false
    const next = index + 1 < before.length ? before[index + 1].period_start : periodStart
    if (addDaysIso(before[index].period_end, 1) !== next) return false
  }
  return true
}

/** A component as the engine reads it: numbers, never strings. */
export interface ComponentPlan {
  id: string
  name: string
  cost: number
  salvage: number
  usefulLifeMonths: number | null
  acquisitionDate: string
  depreciationStartDate: string
  opening: { amount: number; date: string } | null
  derecognisedAt: string | null
  sortOrder: number
  /** True for a row of asset_components, whose id the posting RPCs know. */
  registered: boolean
}

function openingOf(amount: unknown, date: string | null | undefined): ComponentPlan['opening'] {
  const value = roundOre(Number(amount ?? 0) || 0)
  return value > 0 && date ? { amount: value, date } : null
}

/**
 * The asset's components in register order: the rows of asset_components
 * when they were loaded (derecognised ones included), else the read-only
 * projection on k3_components, so a caller that selected only the asset row
 * still sees its active components.
 */
export function componentsOf(asset: Pick<Asset, 'acquisition_date' | 'k3_components' | 'components'>): ComponentPlan[] {
  if (Array.isArray(asset.components)) {
    return [...asset.components]
      .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((row: AssetComponent) => ({
        id: row.id,
        name: row.name,
        cost: roundOre(Number(row.cost)),
        salvage: roundOre(Number(row.salvage_value ?? 0)),
        usefulLifeMonths: row.useful_life_months === null ? null : Number(row.useful_life_months),
        acquisitionDate: row.acquisition_date,
        depreciationStartDate: row.depreciation_start_date ?? row.acquisition_date,
        opening: openingOf(row.opening_accumulated_depreciation, row.opening_depreciation_date),
        derecognisedAt: row.derecognised_at,
        sortOrder: row.sort_order,
        registered: true,
      }))
  }
  return (asset.k3_components ?? []).map((element, index) => {
    const acquisitionDate = element.acquisition_date ?? asset.acquisition_date
    return {
      id: element.component_id ?? `k3-${index}`,
      name: element.name?.trim() || `Komponent ${index + 1}`,
      cost: roundOre(Number(element.cost)),
      salvage: roundOre(Number(element.salvage_value ?? 0)),
      usefulLifeMonths:
        element.useful_life_months === null || element.useful_life_months === undefined
          ? null
          : Number(element.useful_life_months),
      acquisitionDate,
      depreciationStartDate: element.depreciation_start_date ?? acquisitionDate,
      opening: openingOf(element.opening_accumulated_depreciation, element.opening_depreciation_date),
      derecognisedAt: null,
      sortOrder: index,
      // The projection names its rows; a legacy value without ids has none.
      registered: Boolean(element.component_id),
    }
  })
}

/** The components still on the books. */
export function activeComponentsOf(asset: Pick<Asset, 'acquisition_date' | 'k3_components' | 'components'>): ComponentPlan[] {
  return componentsOf(asset).filter((component) => component.derecognisedAt === null)
}

/** True when the asset is depreciated per component. */
export function hasComponents(asset: Pick<Asset, 'acquisition_date' | 'k3_components' | 'components'>): boolean {
  return activeComponentsOf(asset).length > 0
}

/** Per-component history before a period, by component id. */
export interface ComponentHistoryBefore {
  posted?: ReadonlyMap<string, number>
  writtenDown?: ReadonlyMap<string, number>
  revalued?: ReadonlyMap<string, number>
  /** Whether every year from a plan anchor to the period has its
   *  depreciation posted (historyCompleteFrom). Absent: only a plan
   *  anchored in the period itself counts as whole. */
  isComplete?: (anchor: string) => boolean
}

export function componentUnit(
  component: ComponentPlan,
  history: ComponentHistoryBefore,
  endDate: string | null,
  periodStart: string,
): DepreciationUnit {
  const anchor = planAnchor({ startDate: component.depreciationStartDate, opening: component.opening })
  return {
    key: component.id,
    name: component.name,
    cost: component.cost,
    salvage: component.salvage,
    usefulLifeMonths: component.usefulLifeMonths,
    startDate: component.depreciationStartDate,
    opening: component.opening,
    postedBefore: roundOre(history.posted?.get(component.id) ?? 0),
    writtenDownBefore: roundOre(history.writtenDown?.get(component.id) ?? 0),
    revaluedBefore: roundOre(history.revalued?.get(component.id) ?? 0),
    endDate,
    historyComplete: anchor >= periodStart || (history.isComplete?.(anchor) ?? false),
  }
}

export interface ComponentCharge {
  componentId: string
  name: string
  amount: number
  /** The component's opening snapshot the charge was computed from (the
   *  posting RPC refuses it when it changed in between). */
  openingAmount: number
  openingDate: string | null
  /** False for a legacy component with no register row: no split is posted. */
  registered: boolean
}

export interface ComponentDepreciationResult {
  /** Sum of the per-component charges. */
  amount: number
  /** True if any component was charged for part of the period. */
  proRated: boolean
  /** One line per component on the books in the period (zero charges included,
   *  so the posting covers every active component); sums exactly to `amount`. */
  perComponent: ComponentCharge[]
}

/**
 * The asset's planenlig avskrivning for a period, per component. Components
 * derecognised on or before the period's last day are left out: their last
 * charge was on the derecognition voucher. The asset's disposal date (when
 * set) ends every component's window.
 */
export function computeComponentDepreciation(
  asset: Pick<Asset, 'acquisition_date' | 'k3_components' | 'components' | 'disposed_at'>,
  fiscalPeriod: Period,
  history: ComponentHistoryBefore = {},
): ComponentDepreciationResult {
  const perComponent: ComponentCharge[] = []
  let total = 0
  let proRated = false
  for (const component of componentsOf(asset)) {
    if (component.derecognisedAt !== null && component.derecognisedAt <= fiscalPeriod.period_end) continue
    const unit = componentUnit(
      component,
      history,
      asset.disposed_at ?? component.derecognisedAt,
      fiscalPeriod.period_start,
    )
    const charge = computeUnitCharge(unit, fiscalPeriod)
    if (charge.proRated && charge.amount > 0) proRated = true
    total = roundOre(total + charge.amount)
    perComponent.push({
      componentId: component.id,
      name: component.name,
      amount: charge.amount,
      openingAmount: component.opening?.amount ?? 0,
      openingDate: component.opening?.date ?? null,
      registered: component.registered,
    })
  }
  return { amount: total, proRated, perComponent }
}

/** The register's view of a component on a date: what is on the books. */
export interface ComponentBalance {
  componentId: string
  name: string
  cost: number
  /** Opening plus everything posted (and the given charge to date). */
  accumulatedDepreciation: number
  writtenDown: number
  revalued: number
  carryingAmount: number
}

export function componentBalance(
  component: ComponentPlan,
  history: { posted: number; writtenDown?: number; revalued?: number },
): ComponentBalance {
  const accumulatedDepreciation = roundOre((component.opening?.amount ?? 0) + history.posted)
  const writtenDown = roundOre(history.writtenDown ?? 0)
  const revalued = roundOre(history.revalued ?? 0)
  return {
    componentId: component.id,
    name: component.name,
    cost: component.cost,
    accumulatedDepreciation,
    writtenDown,
    revalued,
    carryingAmount: roundOre(component.cost + revalued - accumulatedDepreciation - writtenDown),
  }
}
