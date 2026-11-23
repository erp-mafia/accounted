/**
 * Anläggningstillgångar roll-forward note (ÅRL 5:8 §).
 *
 * Required disclosure per category:
 *   - Ingående anskaffningsvärde
 *   + Årets inköp (tillkommande tillgångar)
 *   − Årets försäljningar/utrangeringar (avgående)
 *   = Utgående anskaffningsvärde
 *
 *   - Ingående ackumulerade avskrivningar
 *   + Årets avskrivningar
 *   − Avskrivningar på avgående tillgångar
 *   = Utgående ackumulerade avskrivningar
 *
 *   - Ingående ackumulerade nedskrivningar (ÅRL 5:8 § p. 5, årets nedskrivningar)
 *   + Årets nedskrivningar
 *   − Årets återförda nedskrivningar
 *   − Nedskrivningar på avgående tillgångar
 *   = Utgående ackumulerade nedskrivningar
 *
 *   Utgående redovisat värde = utgående anskaffningsvärde − utgående ack.
 *   avskrivningar − utgående ack. nedskrivningar
 *
 * The write-down rows (writeDownMovement, posted vouchers only) are printed
 * for a category that has any, K2 and K3 alike: write-downs are offered to
 * every company, and a note without them neither tells the year's
 * nedskrivningar nor ties to the balansräkning.
 *
 * Anskaffningsvärden come from the asset register. Depreciation figures are
 * resolved UPSTREAM (asset-note-figures.ts) from posted depreciation
 * schedules, with the booking engine as fallback, so the note ties to the
 * balansräkning and resultaträkning instead of re-deriving a theoretical
 * schedule that can drift from what was actually booked. This module only
 * aggregates per category and formats.
 */

import { roundOre } from '@/lib/money'
import { ASSET_ACQUISITION_TYPES, assetAcquisitionType } from '@/lib/bokslut/assets/acquisition-type'
import type { WriteDownMovement } from '@/lib/bokslut/assets/value-adjustments'
import type { AssetAcquisitionType } from '@/types'
import type { NoteEntry } from './types'
import type { AssetDepreciationFigures } from './asset-note-figures'
import { formatPdfKronor } from './pdf-format'

export interface AnlaggningAsset {
  category: string
  acquisition_date: string
  acquisition_cost: number
  salvage_value: number
  useful_life_months: number
  disposed_at: string | null
  /** How the asset came onto the books (assets.acquisition_type); absent: a purchase. */
  acquisition_type?: AssetAcquisitionType
  /** The BAS account the asset is booked on: the K2 note groups by its balance sheet post. */
  bas_asset_account?: string
  figures: AssetDepreciationFigures
  /** The year's movement in accumulated write-downs (writeDownMovement); absent: none. */
  writeDowns?: WriteDownMovement
}

export interface CategoryRollforward {
  /** The group the row sums: the register category, or the caller's own key. */
  category: string
  ibAnskaffning: number
  tillkommande: number
  /** The year's new assets by how they came in (assets.acquisition_type); they sum to `tillkommande`. */
  tillkommandePerSatt: Record<AssetAcquisitionType, number>
  /**
   * Accumulated avskrivningar the year's new assets carried when they came
   * in (an asset's opening amount), by how they came in. Not part of `ibAck`:
   * the asset was not on the books at the start of the year.
   */
  overtagnaAck: Record<AssetAcquisitionType, number>
  avgaende: number
  ubAnskaffning: number
  ibAck: number
  aretsAvskrivning: number
  avgaendeAck: number
  ubAck: number
  /** Accumulated write-downs (ÅRL 4 kap. 5 §): opening, the year's, reversed, on disposals, closing. */
  ibNed: number
  aretsNed: number
  aterfordaNed: number
  avgaendeNed: number
  ubNed: number
  ubRedovisat: number
}

/**
 * The principle sentence for mark (category land), K2 and K3 alike: mark
 * has no limited useful life and is never depreciated (BFNAR 2016:10 kap.
 * 10, BFNAR 2012:1 17.4), only written down (ÅRL 4 kap. 5 §).
 */
export const MARK_NOT_DEPRECIATED = 'Mark skrivs inte av.'

export const CATEGORY_LABELS: Record<string, string> = {
  immaterial: 'Immateriella anläggningstillgångar',
  building: 'Byggnader',
  land: 'Mark',
  land_improvement: 'Markanläggningar',
  machinery: 'Maskiner',
  equipment: 'Inventarier',
  vehicle: 'Fordon',
  computer: 'Datorer',
  other_tangible: 'Övriga materiella anläggningstillgångar',
}

/**
 * The K2 "Avskrivningar" note: the depreciation period per category of the
 * assets on the books, and that mark is not depreciated. Mark has no
 * limited useful life (useful_life_months 0), so it is never a "0 år" row.
 * Empty when there is nothing to say.
 */
export function depreciationPrincipleLines(
  assets: ReadonlyArray<{ category: string; useful_life_months: number; disposed_at: string | null }>,
): string[] {
  const byCategory = new Map<string, Set<number>>()
  let holdsLand = false
  for (const asset of assets) {
    if (asset.disposed_at) continue
    if (asset.category === 'land') {
      holdsLand = true
      continue
    }
    const years = Math.round(asset.useful_life_months / 12)
    if (!byCategory.has(asset.category)) byCategory.set(asset.category, new Set())
    byCategory.get(asset.category)!.add(years)
  }
  const lines: string[] = byCategory.size > 0 ? ['Avskrivningar görs linjärt över bedömd nyttjandeperiod:'] : []
  for (const [category, yearsSet] of byCategory.entries()) {
    const years = Array.from(yearsSet).sort((a, b) => a - b)
    const label = years.length === 1 ? `${years[0]} år` : `${years[0]}-${years[years.length - 1]} år`
    lines.push(`• ${CATEGORY_LABELS[category] ?? category}: ${label}`)
  }
  if (holdsLand) lines.push(MARK_NOT_DEPRECIATED)
  return lines
}

const zeroPerSatt = (): Record<AssetAcquisitionType, number> => ({
  purchase: 0,
  business_acquisition: 0,
  merger: 0,
  reclassification: 0,
})

/** A group nothing has moved in. */
export function emptyRollforward(category: string): CategoryRollforward {
  return {
    category,
    ibAnskaffning: 0,
    tillkommande: 0,
    tillkommandePerSatt: zeroPerSatt(),
    overtagnaAck: zeroPerSatt(),
    avgaende: 0,
    ubAnskaffning: 0,
    ibAck: 0,
    aretsAvskrivning: 0,
    avgaendeAck: 0,
    ubAck: 0,
    ibNed: 0,
    aretsNed: 0,
    aterfordaNed: 0,
    avgaendeNed: 0,
    ubNed: 0,
    ubRedovisat: 0,
  }
}

/**
 * The year's roll-forward per group of assets: per register category, or
 * per `keyOf` (the K2 note groups per balance sheet post).
 */
export function buildRollforward(
  assets: AnlaggningAsset[],
  periodStart: string,
  periodEnd: string,
  keyOf: (asset: AnlaggningAsset) => string = (asset) => asset.category,
): CategoryRollforward[] {
  const byCategory = new Map<string, CategoryRollforward>()

  const getRow = (category: string): CategoryRollforward => {
    let row = byCategory.get(category)
    if (!row) {
      row = emptyRollforward(category)
      byCategory.set(category, row)
    }
    return row
  }

  for (const asset of assets) {
    const acquiredBeforePeriod = asset.acquisition_date < periodStart
    const acquiredDuringPeriod =
      asset.acquisition_date >= periodStart && asset.acquisition_date <= periodEnd
    const disposedBeforePeriod =
      asset.disposed_at != null && asset.disposed_at < periodStart
    const disposedDuringPeriod =
      asset.disposed_at != null &&
      asset.disposed_at >= periodStart &&
      asset.disposed_at <= periodEnd

    // Skip assets entirely outside the period (acquired or disposed before)
    if (disposedBeforePeriod) continue
    if (!acquiredBeforePeriod && !acquiredDuringPeriod) continue

    const row = getRow(keyOf(asset))

    if (acquiredBeforePeriod) {
      // Was on the books at the start of the period
      row.ibAnskaffning += asset.acquisition_cost
      row.ibAck += asset.figures.ibAck
    }
    if (acquiredDuringPeriod) {
      const satt = assetAcquisitionType(asset)
      row.tillkommande += asset.acquisition_cost
      row.tillkommandePerSatt[satt] += asset.acquisition_cost
      // What was depreciated on it before it came onto these books (its
      // opening amount; nothing is posted here before the year).
      row.overtagnaAck[satt] += asset.figures.ibAck
    }
    if (disposedDuringPeriod) {
      row.avgaende += asset.acquisition_cost
      row.avgaendeAck += asset.figures.avgaendeAck
    }

    row.aretsAvskrivning += asset.figures.aretsAvskrivning

    const writeDowns = asset.writeDowns
    if (writeDowns) {
      if (acquiredBeforePeriod) row.ibNed = roundOre(row.ibNed + writeDowns.opening)
      row.aretsNed = roundOre(row.aretsNed + writeDowns.writtenDown)
      row.aterfordaNed = roundOre(row.aterfordaNed + writeDowns.reversed)
      row.avgaendeNed = roundOre(row.avgaendeNed + writeDowns.disposed)
    }
  }

  // Close out totals + ordering
  const rows = Array.from(byCategory.values()).map((r) => {
    const ub = Math.round((r.ibAnskaffning + r.tillkommande - r.avgaende) * 100) / 100
    const ubAck =
      Math.round((r.ibAck + r.aretsAvskrivning - r.avgaendeAck) * 100) / 100
    const ubNed = roundOre(r.ibNed + r.aretsNed - r.aterfordaNed - r.avgaendeNed)
    return {
      ...r,
      ibAnskaffning: Math.round(r.ibAnskaffning * 100) / 100,
      tillkommande: Math.round(r.tillkommande * 100) / 100,
      tillkommandePerSatt: roundedPerSatt(r.tillkommandePerSatt),
      overtagnaAck: roundedPerSatt(r.overtagnaAck),
      avgaende: Math.round(r.avgaende * 100) / 100,
      ubAnskaffning: ub,
      ibAck: Math.round(r.ibAck * 100) / 100,
      aretsAvskrivning: Math.round(r.aretsAvskrivning * 100) / 100,
      avgaendeAck: Math.round(r.avgaendeAck * 100) / 100,
      ubAck,
      ubNed,
      ubRedovisat: roundOre(ub - ubAck - ubNed),
    }
  })

  // Sort by BAS category order (same as CATEGORY_LABELS key order)
  const order = Object.keys(CATEGORY_LABELS)
  rows.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
  return rows
}

function roundedPerSatt(values: Record<AssetAcquisitionType, number>): Record<AssetAcquisitionType, number> {
  const rounded = zeroPerSatt()
  for (const satt of ASSET_ACQUISITION_TYPES) rounded[satt] = roundOre(values[satt])
  return rounded
}

/**
 * Document-level totals for the roll-forward: used by build-data to
 * cross-check the note's closing book value against the balansräkning.
 */
export function computeRollforwardTotals(
  assets: AnlaggningAsset[],
  periodStart: string,
  periodEnd: string,
): { ubRedovisat: number; ubAck: number; ubNed: number } {
  const rows = buildRollforward(assets, periodStart, periodEnd)
  return {
    ubRedovisat:
      Math.round(rows.reduce((sum, r) => sum + r.ubRedovisat, 0) * 100) / 100,
    ubAck: Math.round(rows.reduce((sum, r) => sum + r.ubAck, 0) * 100) / 100,
    ubNed: roundOre(rows.reduce((sum, r) => sum + r.ubNed, 0)),
  }
}

/** True when an asset carries any write-down movement for the year. */
export function holdsWriteDowns(assets: readonly AnlaggningAsset[]): boolean {
  return assets.some((asset) => {
    const w = asset.writeDowns
    return Boolean(w && (w.opening !== 0 || w.writtenDown !== 0 || w.reversed !== 0 || w.disposed !== 0 || w.closing !== 0))
  })
}

// ASCII hyphen for negatives: the note body renders in the ÅR PDF with
// Helvetica/WinAnsi, which has no U+2212 glyph.
const fmt = (n: number) => formatPdfKronor(n)

/**
 * Build the anläggningstillgångar roll-forward note. Returns null when no
 * assets fall within the period: the caller should skip the note.
 */
export function buildAnlaggningstillgangarNote(params: {
  noteNumber: number
  assets: AnlaggningAsset[]
  periodStart: string
  periodEnd: string
}): NoteEntry | null {
  const { noteNumber, assets, periodStart, periodEnd } = params
  const rows = buildRollforward(assets, periodStart, periodEnd)
  if (rows.length === 0) return null

  // A reduction is written with a leading minus, except a zero one: "-0 kr"
  // reads as a typo in the filed document.
  const minus = (n: number) => (fmt(n) === fmt(0) ? fmt(0) : `-${fmt(n)}`)
  const lines: string[] = []
  for (const row of rows) {
    const label = CATEGORY_LABELS[row.category] ?? row.category
    lines.push(label)
    lines.push(`  Ingående anskaffningsvärde: ${fmt(row.ibAnskaffning)} kr`)
    if (row.tillkommande !== 0)
      lines.push(`  Årets inköp: ${fmt(row.tillkommande)} kr`)
    if (row.avgaende !== 0)
      lines.push(`  Årets försäljningar/utrangeringar: ${minus(row.avgaende)} kr`)
    lines.push(`  Utgående anskaffningsvärde: ${fmt(row.ubAnskaffning)} kr`)
    lines.push(`  Ingående ackumulerade avskrivningar: ${minus(row.ibAck)} kr`)
    if (row.aretsAvskrivning !== 0)
      lines.push(`  Årets avskrivningar: ${minus(row.aretsAvskrivning)} kr`)
    if (row.avgaendeAck !== 0)
      lines.push(`  Återförda avskrivningar på avgående: ${fmt(row.avgaendeAck)} kr`)
    lines.push(`  Utgående ackumulerade avskrivningar: ${minus(row.ubAck)} kr`)
    // ÅRL 5 kap. 8 § p. 5: årets nedskrivningar, for a category that has any.
    if (row.ibNed !== 0 || row.aretsNed !== 0 || row.aterfordaNed !== 0 || row.avgaendeNed !== 0 || row.ubNed !== 0) {
      lines.push(`  Ingående ackumulerade nedskrivningar: ${minus(row.ibNed)} kr`)
      if (row.aretsNed !== 0) lines.push(`  Årets nedskrivningar: ${minus(row.aretsNed)} kr`)
      if (row.aterfordaNed !== 0) lines.push(`  Årets återförda nedskrivningar: ${fmt(row.aterfordaNed)} kr`)
      if (row.avgaendeNed !== 0) lines.push(`  Återförda nedskrivningar på avgående: ${fmt(row.avgaendeNed)} kr`)
      lines.push(`  Utgående ackumulerade nedskrivningar: ${minus(row.ubNed)} kr`)
    }
    lines.push(`  Utgående redovisat värde: ${fmt(row.ubRedovisat)} kr`)
    lines.push('')
  }

  return {
    number: noteNumber,
    title: 'Anläggningstillgångar',
    body: lines.join('\n').trimEnd(),
  }
}

export { buildRollforward as _buildRollforwardForTests }
