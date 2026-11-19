/**
 * Tax depreciation of buildings and markanläggningar (IL 19 kap. 4-5 a §§,
 * 20 kap. 4-5 §§) and the INK2S punkt 4.9 adjustment it gives. Pure.
 *
 * The tax plan is straight-line on the tax basis: a percentage a year (set
 * by the building's economic life, IL 19:5; at most five percent for a
 * markanläggning, ten for täckdiken and skogsvägar, IL 20:5) from the day
 * the building was completed or acquired, pro rata for the part of a fiscal
 * year it is held, scaled by the year's length in months. A hyreshus newly
 * built, extended or rebuilt adds the primäravdrag (IL 19:5 a): two
 * percentage points a year for the six years from completion. The plan never
 * deducts more than the basis.
 *
 * The tax basis is the acquisition value: for a K3 component asset the
 * depreciable components, never the mark component (mark is never written
 * off, for tax either).
 *
 * INK2S 4.9 corrects the books to the tax plan: the year's book
 * depreciation and net write-down on buildings, markanläggningar and mark
 * are added back (7666), the year's tax depreciation deducted (7765), filed
 * net in whichever field it falls.
 */
import { roundOre } from '@/lib/money'
import { activeComponentsOf, hasComponents } from './component-depreciation'
import { addDaysIso, addMonthsIso, earlierIso, laterIso, monthsBetween } from './plan-calendar'
import type { Asset, FiscalPeriod } from '@/types'

type Period = Pick<FiscalPeriod, 'period_start' | 'period_end'>

/** The categories IL 19 and 20 kap. cover in the register. */
export function isTaxRealProperty(asset: Pick<Asset, 'category'>): boolean {
  return asset.category === 'building' || asset.category === 'land_improvement' || asset.category === 'land'
}

/** The asset's tax plan, or null when none is stated (or it is mark). */
export interface TaxPlan {
  basis: number
  /** Percent a year. */
  rate: number
  from: string
  primaryAllowance: boolean
  /** Last day held: the disposal date, if any. */
  until: string | null
}

export function taxPlanOf(
  asset: Pick<
    Asset,
    | 'category'
    | 'acquisition_date'
    | 'acquisition_cost'
    | 'k3_components'
    | 'components'
    | 'disposed_at'
    | 'tax_depreciation_rate'
    | 'tax_depreciation_from'
    | 'tax_primary_allowance'
  >,
): TaxPlan | null {
  const rate = Number(asset.tax_depreciation_rate)
  if (asset.category === 'land' || !(rate > 0)) return null
  const basis = hasComponents(asset)
    ? roundOre(
        activeComponentsOf(asset)
          .filter((component) => component.usefulLifeMonths !== null)
          .reduce((sum, component) => sum + component.cost, 0),
      )
    : roundOre(Number(asset.acquisition_cost))
  return {
    basis,
    rate,
    from: asset.tax_depreciation_from && asset.tax_depreciation_from > asset.acquisition_date
      ? asset.tax_depreciation_from
      : asset.acquisition_date,
    primaryAllowance: asset.category === 'building' && asset.tax_primary_allowance === true,
    until: asset.disposed_at ?? null,
  }
}

/**
 * The asset's tax plan for the fiscal year starting yearStart, or null when
 * the plan does not reach that year: it was stated after the year was
 * closed, locked or put behind the lock date (tax_plan_applies_from, set by
 * the database). Such a year keeps the declaration it was filed with, so
 * INK2S 4.9 and its taxable result never move.
 */
export function taxPlanForYear(
  asset: Parameters<typeof taxPlanOf>[0] & Pick<Asset, 'tax_plan_applies_from'>,
  yearStart: string,
): TaxPlan | null {
  const plan = taxPlanOf(asset)
  if (!plan) return null
  const appliesFrom = asset.tax_plan_applies_from ?? null
  return appliesFrom && yearStart < appliesFrom ? null : plan
}

/** Months the plan runs within [start, endInclusive], as a share of 12 a year. */
function planYears(plan: TaxPlan, start: string, endInclusive: string, cap?: string): number {
  const from = laterIso(start, plan.from)
  let to = endInclusive
  if (plan.until) to = earlierIso(to, plan.until)
  if (cap) to = earlierIso(to, cap)
  if (to < from) return 0
  return monthsBetween(from, addDaysIso(to, 1)) / 12
}

/**
 * The tax depreciation of [start, endInclusive] before the cap: the base
 * rate, and the primäravdrag inside its six years.
 */
function planned(plan: TaxPlan, start: string, endInclusive: string): number {
  const base = plan.basis * (plan.rate / 100) * planYears(plan, start, endInclusive)
  if (!plan.primaryAllowance) return base
  const sixYearsEnd = addDaysIso(addMonthsIso(plan.from, 72), -1)
  return base + plan.basis * 0.02 * planYears(plan, start, endInclusive, sixYearsEnd)
}

/** The tax depreciation deducted before a day (the plan from its start). */
export function taxDepreciationBefore(plan: TaxPlan, day: string): number {
  if (day <= plan.from) return 0
  return roundOre(Math.min(plan.basis, planned(plan, plan.from, addDaysIso(day, -1))))
}

/** The year's tax depreciation (whole kronor), never past the basis. */
export function taxDepreciationForYear(plan: TaxPlan, period: Period): number {
  const before = taxDepreciationBefore(plan, period.period_start)
  const left = roundOre(plan.basis - before)
  if (left <= 0) return 0
  const amount = Math.round(planned(plan, period.period_start, period.period_end))
  return roundOre(Math.min(amount, left))
}

/** The tax value at the end of a day: the basis less the tax depreciation through it. */
export function taxValueAt(plan: TaxPlan, day: string): number {
  return roundOre(Math.max(0, plan.basis - taxDepreciationBefore(plan, addDaysIso(day, 1))))
}

/** One asset's part of INK2S 4.9. */
export interface BuildingTaxLine {
  assetId: string
  name: string
  /** The year's book depreciation and net write-down (added back). */
  book: number
  /** The year's tax depreciation (deducted); null without a tax plan. */
  tax: number | null
}

export interface BuildingTaxAdjustment {
  /** Net 4.9: positive files on 7666 (+), negative on 7765 (-). */
  net: number
  lines: BuildingTaxLine[]
  warnings: string[]
}

/**
 * INK2S 4.9 for the year from each asset's book charge and tax plan. An
 * asset without a tax plan (and not mark) makes no adjustment and a warning:
 * its book depreciation stands as the deduction, as before this existed.
 */
export function buildingTaxAdjustment(
  inputs: ReadonlyArray<{ asset: Asset; book: number }>,
  period: Period,
): BuildingTaxAdjustment {
  const lines: BuildingTaxLine[] = []
  const warnings: string[] = []
  let net = 0
  for (const { asset, book } of inputs) {
    if (!isTaxRealProperty(asset)) continue
    if (asset.disposed_at && asset.disposed_at < period.period_start) continue
    const plan = taxPlanForYear(asset, period.period_start)
    if (asset.category === 'land') {
      // Mark is never written off for tax: a book write-down is added back.
      if (Math.abs(book) >= 0.005) {
        lines.push({ assetId: asset.id, name: asset.name, book, tax: 0 })
        net = roundOre(net + book)
      }
      continue
    }
    if (!plan) {
      if (Math.abs(book) >= 0.005) {
        warnings.push(
          `${asset.name}: ange skattemässig avskrivning (procent per år, IL 19 kap. 5 § eller 20 kap. 5 §) i anläggningsregistret. Utan den görs ingen justering i INK2S 4.9 och den bokförda avskrivningen står som avdrag.`,
        )
      }
      lines.push({ assetId: asset.id, name: asset.name, book, tax: null })
      continue
    }
    const tax = taxDepreciationForYear(plan, period)
    lines.push({ assetId: asset.id, name: asset.name, book, tax })
    net = roundOre(net + book - tax)
    if (asset.disposed_at && asset.disposed_at <= period.period_end) {
      warnings.push(
        `${asset.name} har avyttrats under året: fyll i den skattemässiga vinsten eller förlusten (INK2S 4.10, fastighetsförsäljning) separat.`,
      )
    }
  }
  return { net, lines, warnings }
}
