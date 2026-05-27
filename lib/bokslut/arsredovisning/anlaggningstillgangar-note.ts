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
 *   Utgående redovisat värde = utgående anskaffningsvärde − utgående ack. avskrivningar
 *
 * Driven entirely off the assets table. Accumulated depreciation is
 * computed from the linear schedule (acquisition_date, useful_life_months,
 * salvage_value) at the relevant as-of date — we do not depend on
 * journal-derived avskrivningskonton because not all companies post
 * monthly avskrivningar.
 */

import type { NoteEntry } from './types'

export interface AnlaggningAsset {
  category: string
  acquisition_date: string
  acquisition_cost: number
  salvage_value: number
  useful_life_months: number
  disposed_at: string | null
}

interface CategoryRollforward {
  category: string
  ibAnskaffning: number
  tillkommande: number
  avgaende: number
  ubAnskaffning: number
  ibAck: number
  aretsAvskrivning: number
  avgaendeAck: number
  ubAck: number
  ubRedovisat: number
}

const CATEGORY_LABELS: Record<string, string> = {
  immaterial: 'Immateriella anläggningstillgångar',
  building: 'Byggnader',
  land_improvement: 'Markanläggningar',
  machinery: 'Maskiner',
  equipment: 'Inventarier',
  vehicle: 'Fordon',
  computer: 'Datorer',
  other_tangible: 'Övriga materiella anläggningstillgångar',
}

function daysBetween(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00Z`)
  const end = new Date(`${endIso}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  if (end < start) return 0
  return Math.floor((end.getTime() - start.getTime()) / 86400000)
}

/**
 * Linear depreciation accumulated between acquisition_date and asOfIso.
 * Caps at (cost − salvage) once useful life elapses. Day-based pro-rata
 * matching how computeLinearDepreciation pro-rates the first/last year.
 */
function accumulatedDepreciation(
  asset: AnlaggningAsset,
  asOfIso: string,
): number {
  if (asOfIso < asset.acquisition_date) return 0
  const lifeDays = asset.useful_life_months * (365.25 / 12)
  const elapsedDays = Math.min(lifeDays, daysBetween(asset.acquisition_date, asOfIso))
  if (lifeDays === 0) return 0
  const depreciable = asset.acquisition_cost - asset.salvage_value
  return Math.round((depreciable * elapsedDays) / lifeDays * 100) / 100
}

/** ISO date one day before a given ISO date. Used for "day before period start". */
function isoMinusOneDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function buildRollforward(
  assets: AnlaggningAsset[],
  periodStart: string,
  periodEnd: string,
): CategoryRollforward[] {
  const dayBeforeStart = isoMinusOneDay(periodStart)
  const byCategory = new Map<string, CategoryRollforward>()

  const getRow = (category: string): CategoryRollforward => {
    let row = byCategory.get(category)
    if (!row) {
      row = {
        category,
        ibAnskaffning: 0,
        tillkommande: 0,
        avgaende: 0,
        ubAnskaffning: 0,
        ibAck: 0,
        aretsAvskrivning: 0,
        avgaendeAck: 0,
        ubAck: 0,
        ubRedovisat: 0,
      }
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

    const row = getRow(asset.category)

    if (acquiredBeforePeriod) {
      // Was on the books at the start of the period
      row.ibAnskaffning += asset.acquisition_cost
      row.ibAck += accumulatedDepreciation(asset, dayBeforeStart)
    }
    if (acquiredDuringPeriod) {
      row.tillkommande += asset.acquisition_cost
    }
    if (disposedDuringPeriod) {
      row.avgaende += asset.acquisition_cost
      row.avgaendeAck += accumulatedDepreciation(asset, asset.disposed_at!)
    }

    // Year's depreciation: from max(acquisition_date, period_start)
    // to min(disposed_at ?? period_end, period_end). Computed as the
    // delta in accumulated depreciation between those two dates.
    const yearStart =
      asset.acquisition_date > periodStart ? asset.acquisition_date : periodStart
    const yearEnd =
      asset.disposed_at != null && asset.disposed_at < periodEnd
        ? asset.disposed_at
        : periodEnd
    if (yearStart <= yearEnd) {
      const startAck = accumulatedDepreciation(asset, isoMinusOneDay(yearStart))
      const endAck = accumulatedDepreciation(asset, yearEnd)
      row.aretsAvskrivning += Math.max(0, endAck - startAck)
    }
  }

  // Close out totals + ordering
  const rows = Array.from(byCategory.values()).map((r) => {
    const ub = Math.round((r.ibAnskaffning + r.tillkommande - r.avgaende) * 100) / 100
    const ubAck =
      Math.round((r.ibAck + r.aretsAvskrivning - r.avgaendeAck) * 100) / 100
    return {
      ...r,
      ibAnskaffning: Math.round(r.ibAnskaffning * 100) / 100,
      tillkommande: Math.round(r.tillkommande * 100) / 100,
      avgaende: Math.round(r.avgaende * 100) / 100,
      ubAnskaffning: ub,
      ibAck: Math.round(r.ibAck * 100) / 100,
      aretsAvskrivning: Math.round(r.aretsAvskrivning * 100) / 100,
      avgaendeAck: Math.round(r.avgaendeAck * 100) / 100,
      ubAck,
      ubRedovisat: Math.round((ub - ubAck) * 100) / 100,
    }
  })

  // Sort by BAS category order (same as CATEGORY_LABELS key order)
  const order = Object.keys(CATEGORY_LABELS)
  rows.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
  return rows
}

const fmt = (n: number) => Math.round(n).toLocaleString('sv-SE')

/**
 * Build the anläggningstillgångar roll-forward note. Returns null when no
 * assets fall within the period — the caller should skip the note.
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

  const lines: string[] = []
  for (const row of rows) {
    const label = CATEGORY_LABELS[row.category] ?? row.category
    lines.push(label)
    lines.push(`  Ingående anskaffningsvärde: ${fmt(row.ibAnskaffning)} kr`)
    if (row.tillkommande !== 0)
      lines.push(`  Årets inköp: ${fmt(row.tillkommande)} kr`)
    if (row.avgaende !== 0)
      lines.push(`  Årets försäljningar/utrangeringar: -${fmt(row.avgaende)} kr`)
    lines.push(`  Utgående anskaffningsvärde: ${fmt(row.ubAnskaffning)} kr`)
    lines.push(`  Ingående ackumulerade avskrivningar: -${fmt(row.ibAck)} kr`)
    if (row.aretsAvskrivning !== 0)
      lines.push(`  Årets avskrivningar: -${fmt(row.aretsAvskrivning)} kr`)
    if (row.avgaendeAck !== 0)
      lines.push(`  Återförda avskrivningar på avgående: ${fmt(row.avgaendeAck)} kr`)
    lines.push(`  Utgående ackumulerade avskrivningar: -${fmt(row.ubAck)} kr`)
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
