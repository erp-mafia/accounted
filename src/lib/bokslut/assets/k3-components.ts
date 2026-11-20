/**
 * K3 component validation and opening allocation (BFNAR 2012:1 17.4, 17.11,
 * 17.13, 17.18). Pure functions (no I/O), shared by the Zod refinements on
 * the asset contracts (asset-api.ts), the asset service and the dialogs.
 *
 * The database enforces the per-component rules again (asset_components
 * CHECKs and guard_asset_components); the cross-row rule "the components sum
 * to the acquisition cost" lives here, because the asset row's cost becomes
 * the components' sum (sync_asset_components_projection) and a silent
 * difference would move the register away from the ledger.
 */
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { roundOre } from '@/lib/money'
import { addDaysIso, addMonthsIso, monthsBetween } from './plan-calendar'
import type { K3Component } from '@/types'

export interface ValidationResult {
  /** Human-readable Swedish error messages. Empty array = valid. */
  errors: string[]
}

const ISO_DATE = ISO_DATE_RE

function componentLabel(component: K3Component, index: number): string {
  return component.name?.trim() || `komponent ${index + 1}`
}

/**
 * Validate an asset's K3 component breakdown on its own and against the
 * asset's acquisition cost and date. Returns every issue at once.
 *
 * - non-empty when given; each component named, cost above 0, a positive
 *   whole number of months or null (not depreciated, mark per 17.13),
 *   salvage value between 0 and the cost;
 * - acquisition and depreciation-start dates not before the asset's
 *   acquisition date, the start not before the component's own acquisition;
 * - an opening amount between 0 and the cost less salvage value, with the
 *   date it is stated per (not before the component's acquisition); none on
 *   a component that is not depreciated;
 * - the costs sum to the acquisition cost to the öre.
 */
export function validateComponents(asset: {
  acquisition_cost: number
  acquisition_date?: string
  k3_components: K3Component[] | null | undefined
}): ValidationResult {
  const errors: string[] = []
  const components = asset.k3_components

  if (components === null || components === undefined) {
    return { errors: [] }
  }

  if (!Array.isArray(components)) {
    errors.push('k3_components måste vara en lista av komponenter eller null.')
    return { errors }
  }

  if (components.length === 0) {
    errors.push(
      'k3_components får inte vara en tom lista: sätt fältet till null om tillgången inte använder komponentuppdelning.',
    )
    return { errors }
  }

  const seenIds = new Set<string>()
  let totalCost = 0
  components.forEach((component, index) => {
    const label = componentLabel(component, index)
    if (component.component_id) {
      if (seenIds.has(component.component_id)) errors.push(`${label}: komponenten finns två gånger.`)
      seenIds.add(component.component_id)
    }
    if (typeof component.cost !== 'number' || !Number.isFinite(component.cost)) {
      errors.push(`${label}: anskaffningsvärdet måste vara ett tal.`)
      return
    }
    if (component.cost <= 0) {
      errors.push(`${label}: anskaffningsvärdet måste vara större än 0.`)
    }
    const life = component.useful_life_months
    if (
      life !== null &&
      (typeof life !== 'number' || !Number.isInteger(life) || life <= 0)
    ) {
      errors.push(`${label}: nyttjandeperioden måste vara ett positivt heltal månader, eller tom för mark som inte skrivs av.`)
    }
    const salvage = Number(component.salvage_value ?? 0)
    if (!Number.isFinite(salvage) || salvage < 0) {
      errors.push(`${label}: restvärdet får inte vara negativt.`)
    } else if (salvage > component.cost) {
      errors.push(
        `${label}: restvärdet (${salvage} kr) får inte överstiga anskaffningsvärdet (${component.cost} kr).`,
      )
    }

    const acquired = component.acquisition_date ?? asset.acquisition_date ?? null
    if (component.acquisition_date && !ISO_DATE.test(component.acquisition_date)) {
      errors.push(`${label}: anskaffningsdatumet måste vara ett datum (åååå-mm-dd).`)
    } else if (component.acquisition_date && asset.acquisition_date && component.acquisition_date < asset.acquisition_date) {
      errors.push(`${label}: komponenten kan inte vara anskaffad före tillgången.`)
    }
    const start = component.depreciation_start_date ?? null
    if (start && !ISO_DATE.test(start)) {
      errors.push(`${label}: avskrivningsstarten måste vara ett datum (åååå-mm-dd).`)
    } else if (start && acquired && start < acquired) {
      errors.push(`${label}: avskrivningen kan inte börja före anskaffningen.`)
    }

    const opening = Number(component.opening_accumulated_depreciation ?? 0)
    const openingDate = component.opening_depreciation_date ?? null
    if (!Number.isFinite(opening) || opening < 0) {
      errors.push(`${label}: redan avskrivet belopp får inte vara negativt.`)
    } else if (opening > 0) {
      if (life === null) {
        errors.push(`${label}: en komponent som inte skrivs av kan inte ha redan avskrivet belopp.`)
      } else if (opening > roundOre(component.cost - salvage)) {
        errors.push(`${label}: redan avskrivet belopp får inte överstiga anskaffningsvärdet minus restvärdet.`)
      }
      if (!openingDate) {
        errors.push(`${label}: ange datumet som redan avskrivet belopp avser.`)
      } else if (acquired && openingDate < acquired) {
        errors.push(`${label}: datumet för redan avskrivet belopp får inte vara före anskaffningsdatumet.`)
      }
    }
    totalCost = roundOre(totalCost + component.cost)
  })

  const expected = roundOre(Number(asset.acquisition_cost))
  if (Number.isFinite(expected) && Math.abs(totalCost - expected) > 0.005) {
    errors.push(
      `Komponenterna summerar till ${totalCost} kr men tillgångens anskaffningsvärde är ${expected} kr. Fördela hela anskaffningsvärdet på komponenterna.`,
    )
  }

  return { errors }
}

/**
 * Split an opening accumulated depreciation stated for the whole asset over
 * its components, when the components do not state their own: each
 * depreciable component in proportion to what its own straight-line plan
 * would have written off by the opening date (its depreciable base times the
 * share of its life that had passed), capped at its depreciable base. A
 * component that is not depreciated takes nothing. The split sums to the
 * total to the öre; the caller has checked the total against the bases.
 *
 * This is the default a migration can start from; the result is what the
 * register stores and what the user sees and can edit per component before
 * anything is posted.
 */
export function allocateOpeningToComponents(
  components: readonly K3Component[],
  opening: { amount: number; date: string },
  assetAcquisitionDate: string,
): K3Component[] {
  const total = roundOre(opening.amount)
  const bases = components.map((component) =>
    component.useful_life_months === null
      ? 0
      : Math.max(0, roundOre(component.cost - Number(component.salvage_value ?? 0))),
  )
  const elapsedShares = components.map((component, index) => {
    if (component.useful_life_months === null || bases[index] <= 0) return 0
    const start = component.depreciation_start_date ?? component.acquisition_date ?? assetAcquisitionDate
    const months = monthsBetween(start, addDaysIso(opening.date, 1))
    const lifeEnd = addMonthsIso(start, component.useful_life_months)
    const life = monthsBetween(start, lifeEnd)
    return life > 0 ? Math.min(1, months / life) * bases[index] : 0
  })
  const weightSum = elapsedShares.reduce((sum, weight) => sum + weight, 0)
  const weights = weightSum > 0 ? elapsedShares : bases
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)

  const amounts = weights.map((weight, index) =>
    weightTotal > 0 ? Math.min(bases[index], roundOre((total * weight) / weightTotal)) : 0,
  )
  // Rounding and caps leave a remainder: give it to the components with room
  // left, in register order, so the split sums to the total exactly.
  let remainder = roundOre(total - amounts.reduce((sum, amount) => sum + amount, 0))
  for (let index = 0; index < amounts.length && Math.abs(remainder) > 0.004; index++) {
    const room = remainder > 0 ? roundOre(bases[index] - amounts[index]) : amounts[index]
    const step = remainder > 0 ? Math.min(room, remainder) : -Math.min(room, -remainder)
    amounts[index] = roundOre(amounts[index] + step)
    remainder = roundOre(remainder - step)
  }

  return components.map((component, index) =>
    amounts[index] > 0
      ? { ...component, opening_accumulated_depreciation: amounts[index], opening_depreciation_date: opening.date }
      : { ...component, opening_accumulated_depreciation: 0, opening_depreciation_date: null },
  )
}

/** True when any component states its own opening amount. */
export function componentsStateOpening(components: readonly K3Component[] | null | undefined): boolean {
  return (components ?? []).some((component) => Number(component.opening_accumulated_depreciation ?? 0) > 0)
}

/** The components' opening total, the asset-level figure the register shows. */
export function componentsOpeningTotal(components: readonly K3Component[]): number {
  return roundOre(components.reduce((sum, component) => sum + Number(component.opening_accumulated_depreciation ?? 0), 0))
}
