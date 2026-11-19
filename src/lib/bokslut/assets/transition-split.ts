/**
 * The split of a plain asset on components at the transition to K3 (BFNAR
 * 2012:1 35.18). Pure.
 *
 * 35.18 does not restate the asset: its carrying amount at the transition
 * date is divided on its significant components. Each component is given
 * its carrying amount at the transition and its useful life, counted as for
 * every component from the asset's depreciation start. The accumulated
 * depreciation at the transition (the asset's opening plus everything
 * posted on it as a whole) is carried into the components' openings, spread
 * over the depreciated components by carrying amount, so each component's
 * cost less its opening is its carrying amount and the components together
 * hold the asset's cost and accumulated depreciation unchanged: the split
 * books nothing. From the transition the component engine charges what is
 * left of each component over what is left of its life.
 */
import { roundOre } from '@/lib/money'
import { monthsBetween } from './plan-calendar'
import { allocateByWeight } from './value-adjustment-service'

export interface TransitionSplitInput {
  name: string
  /** The component's carrying amount at the transition date. */
  carrying_amount: number
  /** Total useful life from the asset's depreciation start; null: mark, never depreciated. */
  useful_life_months: number | null
  salvage_value: number
}

/** A component as split_asset_at_k3_transition takes it. */
export interface TransitionSplitRow {
  name: string
  cost: number
  useful_life_months: number | null
  salvage_value: number
  opening_accumulated_depreciation: number
}

export interface TransitionSplitFigures {
  /** The asset's acquisition cost. */
  cost: number
  /** Accumulated depreciation at the transition (opening plus posted). */
  carried: number
  /** The asset's depreciation start. */
  depreciationStart: string
  /** The first day of the first K3 year. */
  transitionDate: string
}

/** Whole months of use before the transition, for the useful-life check. */
export function monthsUsedBefore(figures: Pick<TransitionSplitFigures, 'depreciationStart' | 'transitionDate'>): number {
  return Math.floor(monthsBetween(figures.depreciationStart, figures.transitionDate))
}

export function transitionSplitRows(
  figures: TransitionSplitFigures,
  components: readonly TransitionSplitInput[],
): { rows: TransitionSplitRow[]; errors: string[] } {
  const errors: string[] = []
  const carryingTotal = roundOre(figures.cost - figures.carried)
  const used = monthsUsedBefore(figures)

  if (components.length < 2) {
    errors.push('Dela upp tillgången på minst två betydande komponenter (K3 punkt 17.4).')
  }
  for (const component of components) {
    const name = component.name.trim() || 'Komponenten'
    if (!(component.carrying_amount > 0)) {
      errors.push(`${name}: ange ett redovisat värde över noll.`)
    }
    if (component.salvage_value < 0 || component.salvage_value > component.carrying_amount) {
      errors.push(`${name}: restvärdet kan inte vara större än det redovisade värdet.`)
    }
    if (component.useful_life_months !== null && component.useful_life_months <= used) {
      errors.push(
        `${name}: nyttjandeperioden ska räknas från när tillgången började användas och vara längre än de ${used} månader som gått fram till övergången.`,
      )
    }
  }
  const sum = roundOre(components.reduce((total, component) => total + component.carrying_amount, 0))
  if (sum !== carryingTotal) {
    errors.push(
      `Komponenternas redovisade värden ska tillsammans vara tillgångens redovisade värde vid övergången, ${carryingTotal} kr (nu ${sum} kr).`,
    )
  }
  const depreciated = components
    .map((component, index) => ({ component, index }))
    .filter(({ component }) => component.useful_life_months !== null)
  if (figures.carried > 0 && depreciated.length === 0) {
    errors.push('Den ackumulerade avskrivningen måste föras till en komponent som skrivs av, inte till mark.')
  }
  if (errors.length > 0) return { rows: [], errors }

  // The accumulated depreciation follows the depreciated components'
  // carrying amounts; mark carries none (it is never written off).
  const openings = allocateByWeight(
    figures.carried,
    depreciated.map(({ component, index }) => ({
      key: String(index),
      weight: component.carrying_amount,
      cap: figures.carried,
    })),
  )
  const rows = components.map((component, index) => {
    const opening = roundOre(openings.get(String(index)) ?? 0)
    return {
      name: component.name.trim(),
      cost: roundOre(component.carrying_amount + opening),
      useful_life_months: component.useful_life_months,
      salvage_value: roundOre(component.salvage_value),
      opening_accumulated_depreciation: opening,
    }
  })
  return { rows, errors: [] }
}
