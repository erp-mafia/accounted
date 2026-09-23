/**
 * K3 component depreciation validation (BFNAR 2012:1 ch.17.4).
 *
 * Pure functions (no I/O) so unit tests can exercise edge cases without
 * mocking Supabase or the engine. Shared between the Zod refinement on
 * AssetCreate / AssetUpdate (`lib/api/schemas.ts`) and any callers that
 * want to validate K3 components outside the API surface (MCP, scripts).
 *
 * The cross-column rule "sum(components.cost) ≈ acquisition_cost" cannot
 * be expressed in a Postgres CHECK on JSONB, so we enforce it here. The
 * engine itself does NOT re-validate at depreciation time: callers must
 * ensure the asset row is consistent before persisting.
 */
import type { K3Component } from '@/types'

/** Tolerance for the sum-equals-acquisition-cost check. 1 kr is enough to
 *  absorb öre rounding differences when the user types whole-kronor values
 *  but tight enough to catch real input errors. */
const COMPONENT_SUM_TOLERANCE_KR = 1

export interface ValidationResult {
  /** Human-readable Swedish error messages. Empty array = valid. */
  errors: string[]
}

/**
 * Validate that an asset's K3 component breakdown is internally consistent
 * and matches the asset's acquisition cost.
 *
 * Returns the full list of issues (the API can surface all at once instead
 * of bailing on the first). The check is independent of accounting_framework:
 * that gate sits at the API layer because this module is also used by
 * non-HTTP callers that have already decided to use K3.
 */
export function validateComponents(asset: {
  acquisition_cost: number
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
      'k3_components får inte vara en tom lista: sätt fältet till null om asset inte använder komponentuppdelning.',
    )
    return { errors }
  }

  let totalCost = 0
  components.forEach((component, index) => {
    const label = component.name?.trim() || `komponent ${index + 1}`
    if (typeof component.cost !== 'number' || !Number.isFinite(component.cost)) {
      errors.push(`${label}: anskaffningsvärdet måste vara ett tal.`)
      return
    }
    if (component.cost <= 0) {
      errors.push(`${label}: anskaffningsvärdet måste vara större än 0.`)
    }
    if (
      typeof component.useful_life_months !== 'number'
      || !Number.isInteger(component.useful_life_months)
      || component.useful_life_months <= 0
    ) {
      errors.push(`${label}: nyttjandeperioden måste vara ett positivt heltal månader.`)
    }
    if (component.salvage_value !== undefined && component.salvage_value !== null) {
      if (
        typeof component.salvage_value !== 'number'
        || !Number.isFinite(component.salvage_value)
        || component.salvage_value < 0
      ) {
        errors.push(`${label}: restvärdet får inte vara negativt.`)
      } else if (component.salvage_value > component.cost) {
        errors.push(
          `${label}: restvärdet (${component.salvage_value} kr) får inte överstiga anskaffningsvärdet (${component.cost} kr).`,
        )
      }
    }
    totalCost += component.cost
  })

  const expected = Number(asset.acquisition_cost)
  if (Number.isFinite(expected) && Math.abs(totalCost - expected) > COMPONENT_SUM_TOLERANCE_KR) {
    errors.push(
      `Komponenter summerar till ${Math.round(totalCost * 100) / 100} kr men asset.acquisition_cost är ${Math.round(expected * 100) / 100} kr: differensen får vara högst ${COMPONENT_SUM_TOLERANCE_KR} kr.`,
    )
  }

  return { errors }
}
