/**
 * An asset's carrying amount at the end of a day, from the register: what
 * the balance sheet holds for it, for the comparison with its tax value
 * (K3 29.14). Pure.
 *
 * A plain asset: cost less its opening accumulated depreciation, the
 * planenlig avskrivning posted for years ending on or before the day, and
 * its net write-down through the day.
 *
 * A component asset: the sum over the components on the books that day
 * (acquired on or before it, not derecognised by it) of cost less opening,
 * the component's own posted charges and its net write-down. The
 * asset-level schedule totals are not read for it: what was charged per
 * component is in the splits, a replaced component took its accumulated
 * depreciation off the books when it was derecognised, and a K3 transition
 * split carries the history before it in the components' openings (K3
 * 35.18).
 */
import { roundOre } from '@/lib/money'
import { componentsOf, hasComponents } from './component-depreciation'
import { writtenDownByKey } from './value-adjustments'
import type { Asset } from '@/types'

export interface PostedThrough {
  /** Planenlig avskrivning posted on the asset for years ending on or before the day. */
  total: number
  /** The same schedules' split per component (depreciation_schedule_components). */
  byComponent: ReadonlyMap<string, number>
}

export function carryingAmountAt(
  asset: Pick<
    Asset,
    | 'id'
    | 'acquisition_date'
    | 'acquisition_cost'
    | 'opening_accumulated_depreciation'
    | 'k3_components'
    | 'components'
    | 'value_adjustments'
  >,
  day: string,
  posted: PostedThrough,
): number {
  const writtenDown = writtenDownByKey(asset, { through: day })
  if (!hasComponents(asset)) {
    const cost = roundOre(Number(asset.acquisition_cost) || 0)
    const opening = roundOre(Number(asset.opening_accumulated_depreciation ?? 0) || 0)
    return roundOre(cost - opening - posted.total - (writtenDown.get(asset.id) ?? 0))
  }
  let carrying = 0
  for (const component of componentsOf(asset)) {
    if (component.acquisitionDate > day) continue
    if (component.derecognisedAt !== null && component.derecognisedAt <= day) continue
    carrying = roundOre(
      carrying +
        component.cost -
        (component.opening?.amount ?? 0) -
        (posted.byComponent.get(component.id) ?? 0) -
        (writtenDown.get(component.id) ?? 0),
    )
  }
  return carrying
}
