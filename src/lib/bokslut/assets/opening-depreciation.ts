/**
 * Validation for an asset's opening accumulated depreciation ("Redan
 * avskrivet per <datum>"): depreciation booked in a previous system before
 * the asset entered Accounted. Shared by the create schema (all doors) and
 * the update path, which has to judge the row as it will END UP.
 *
 * The amount never becomes a voucher: it is already in the imported ledger's
 * 12x9 balance. It only tells the depreciation engine how much of the
 * acquisition cost is already written off.
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { K3Component } from '@/types'

export interface OpeningDepreciationCandidate {
  acquisition_cost: number
  acquisition_date: string
  /** Restvärde; the depreciable base is acquisition_cost - salvage_value. */
  salvage_value?: number | null
  opening_accumulated_depreciation?: number | null
  opening_depreciation_date?: string | null
  k3_components?: K3Component[] | null
}

export type OpeningDepreciationIssueKind =
  | 'negative'
  | 'exceeds_cost'
  | 'date_required'
  | 'date_future'
  | 'date_before_acquisition'
  | 'components'

export interface OpeningDepreciationIssue {
  /** Stable key; the dialogs map it to the `assets.opening.error_<kind>`
   *  message in the active locale. */
  kind: OpeningDepreciationIssueKind
  path: 'opening_accumulated_depreciation' | 'opening_depreciation_date'
  /** Swedish message for the API envelope. */
  message: string
}

/**
 * Rules:
 * - 0 <= amount <= acquisition cost - salvage value (the DB CHECK enforces
 *   the same): planenlig avskrivning never writes off the restvärde, so an
 *   opening amount above the depreciable base would leave a negative plan.
 * - An amount above 0 needs the date it is stated per; the date must not be
 *   after today and not before the acquisition date.
 * - Not combined with K3 components: the opening amount is not split per
 *   component, so the engine could not continue each component's plan.
 */
export function validateOpeningDepreciation(
  value: OpeningDepreciationCandidate,
  today: string = todayIsoStockholm(),
): OpeningDepreciationIssue[] {
  const issues: OpeningDepreciationIssue[] = []
  const amount = value.opening_accumulated_depreciation ?? 0
  const date = value.opening_depreciation_date ?? null

  if (!Number.isFinite(amount) || amount < 0) {
    issues.push({
      kind: 'negative',
      path: 'opening_accumulated_depreciation',
      message: 'Redan avskrivet belopp får inte vara negativt.',
    })
    return issues
  }
  const depreciableBase =
    Math.round((value.acquisition_cost - Number(value.salvage_value ?? 0)) * 100) / 100
  if (amount > depreciableBase) {
    issues.push({
      kind: 'exceeds_cost',
      path: 'opening_accumulated_depreciation',
      message: 'Redan avskrivet belopp får inte överstiga anskaffningsvärdet minus restvärdet.',
    })
  }
  if (amount > 0 && !date) {
    issues.push({
      kind: 'date_required',
      path: 'opening_depreciation_date',
      message: 'Ange datumet som redan avskrivet belopp avser.',
    })
  }
  if (amount > 0 && date) {
    if (date > today) {
      issues.push({
        kind: 'date_future',
        path: 'opening_depreciation_date',
        message: 'Datumet för redan avskrivet belopp får inte vara senare än i dag.',
      })
    }
    if (date < value.acquisition_date) {
      issues.push({
        kind: 'date_before_acquisition',
        path: 'opening_depreciation_date',
        message: 'Datumet för redan avskrivet belopp får inte vara före anskaffningsdatumet.',
      })
    }
  }
  if (amount > 0 && Array.isArray(value.k3_components) && value.k3_components.length > 0) {
    issues.push({
      kind: 'components',
      path: 'opening_accumulated_depreciation',
      message:
        'Redan avskrivet belopp för tillgångar med K3-komponenter stöds inte ännu. Behåll komponentuppdelningen.',
    })
  }
  return issues
}

/**
 * Thrown by updateAsset() when the row as it would end up fails
 * validateOpeningDepreciation(). The code maps to a 400 in the structured
 * error registry.
 */
export class AssetOpeningDepreciationInvalidError extends Error {
  readonly code = 'INVALID_OPENING_DEPRECIATION'
  constructor(readonly issues: OpeningDepreciationIssue[]) {
    super(issues.map((issue) => issue.message).join(' '))
    this.name = 'AssetOpeningDepreciationInvalidError'
  }
}
