/**
 * The VAT close check's period comparison (`sanity` on gnubok_vat_close_check
 * and `details.sanity` on v1 compliance/check?type=vat_close): how this
 * momsperiod's sales compare with the previous period of the same length.
 * Advisory only; it never changes ready_to_close.
 *
 * Per rate, from output VAT (#129). Ruta 05 holds the taxable sales of every
 * rate in one box, so the ratio this replaced, ruta 10 / ruta 05, was 0.25 x
 * the 25 % share of sales: a business selling at several rates (lodging at
 * 12 %, services at 25 %) tripped it on an ordinary change in its sales mix,
 * and a 12 % or 6 % error was invisible to it. Rutor 10, 11 and 12 each carry
 * one rate's output VAT, so ruta / rate is that rate's taxable base, the same
 * derivation SALES_OUTPUT_VAT_SHORTFALL uses (vat-declaration-checks.ts).
 *
 * Pure: the caller reads both periods' rutor; this only compares them.
 */
import { roundOre, roundToWholeKronor, sumOre } from '@/lib/money'
import { formatKronor } from '@/lib/utils'
import type { VatDeclarationRutor } from '@/types'

// ── Thresholds ──────────────────────────────────────────────────────────
// A first proposal (#129), to calibrate against real declarations.

/**
 * Kronor. Sales this small are not compared: a rate share is only compared
 * when both periods' taxable base reaches it, a rate's base must move at
 * least this much for rate_share_shift, and revenue_drop / revenue_spike stay
 * quiet unless the larger period's ruta 05 reaches it (2 000 kr to 7 000 kr
 * is +250 %, and noise).
 */
export const VAT_SANITY_FLOOR_KRONOR = 25_000

/** rate_share_shift: percentage points a rate's share must move. */
export const RATE_SHARE_SHIFT_MIN_POINTS = 15

/**
 * rate_share_shift: the rate's base must also move by this percent of the
 * larger period's total base (or by the floor, whichever is more), so a
 * share that moves only because another rate grew does not fire.
 */
export const RATE_BASE_CHANGE_MIN_PCT_OF_TOTAL = 10

/** revenue_drop: ruta 05 falls by more than this percent. */
export const REVENUE_DROP_PCT = 50

/** revenue_spike: ruta 05 rises by more than this percent. */
export const REVENUE_SPIKE_PCT = 200

// ── Types ───────────────────────────────────────────────────────────────

export type VatSanityRate = '25' | '12' | '6'

/** The rutor the comparison reads, signed as filed. */
export type VatSanityRutor = Pick<VatDeclarationRutor, 'ruta05' | 'ruta10' | 'ruta11' | 'ruta12'>

/** Each rate's share of the taxable sales base, in percent (0-100). */
export type VatRateShares = Record<VatSanityRate, number>

export interface VatCloseSanityAnomaly {
  kind: 'rate_share_shift' | 'revenue_drop' | 'revenue_spike'
  /** rate_share_shift only: the rate whose share moved. */
  rate?: VatSanityRate
  /** rate_share_shift: the rate's share, percent. revenue_*: ruta 05, kronor. */
  current: number
  previous: number
  /**
   * rate_share_shift: the change of the share in percentage points.
   * revenue_*: the relative change of ruta 05, percent.
   */
  delta_pct: number
  /** rate_share_shift only: the rate's taxable base in kronor, derived from its output VAT. */
  current_base?: number
  previous_base?: number
  message: string
}

export interface VatCloseSanity {
  anomalies: VatCloseSanityAnomaly[]
  ratios: {
    /**
     * Each rate's share of the taxable base derived from output VAT. null
     * when the period has no positive base or a negative one (a rate whose
     * credit notes exceed its sales), and `previous` null when the previous
     * period was not read.
     */
    rate_shares: { current: VatRateShares | null; previous: VatRateShares | null }
    /**
     * @deprecated Ruta 10 / ruta 05 in percent: 0.25 x the 25 % share of all
     * sales, so it moves with the sales mix. Read rate_shares instead. Kept,
     * unchanged, because details.sanity is public on v1.
     */
    output_vat_ratio_25: number
    /** @deprecated Always 0. Read rate_shares instead. */
    output_vat_ratio_12: number
    /** @deprecated Always 0. Read rate_shares instead. */
    output_vat_ratio_6: number
    previous_period_compared: boolean
  }
}

// ── Comparison ──────────────────────────────────────────────────────────

const RATES: ReadonlyArray<{ rate: VatSanityRate; ruta: 'ruta10' | 'ruta11' | 'ruta12'; factor: number }> = [
  { rate: '25', ruta: 'ruta10', factor: 0.25 },
  { rate: '12', ruta: 'ruta11', factor: 0.12 },
  { rate: '6', ruta: 'ruta12', factor: 0.06 },
]

/** One period as the comparison reads it. */
interface PeriodSales {
  /** Ruta 05. */
  sales: number
  /** Each rate's taxable base, derived from its output VAT. */
  bases: Record<VatSanityRate, number>
  total: number
  /** null when there is nothing to share: no positive total, or a rate whose credit notes exceed its sales. */
  shares: VatRateShares | null
}

function periodSales(rutor: VatSanityRutor): PeriodSales {
  const bases = Object.fromEntries(
    RATES.map(({ rate, ruta, factor }) => [rate, roundOre(rutor[ruta] / factor)]),
  ) as Record<VatSanityRate, number>
  const total = sumOre(Object.values(bases))
  const shareable = total > 0 && Object.values(bases).every((base) => base >= 0)
  const shares = shareable
    ? (Object.fromEntries(RATES.map(({ rate }) => [rate, roundOre((bases[rate] / total) * 100)])) as VatRateShares)
    : null
  return { sales: rutor.ruta05, bases, total, shares }
}

const formatPercent = (n: number) => `${n.toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`
const wholeKronor = (n: number) => formatKronor(roundToWholeKronor(n))

function rateShareShifts(current: PeriodSales, previous: PeriodSales): VatCloseSanityAnomaly[] {
  const currentShares = current.shares
  const previousShares = previous.shares
  if (!currentShares || !previousShares) return []
  if (current.total < VAT_SANITY_FLOOR_KRONOR || previous.total < VAT_SANITY_FLOOR_KRONOR) return []

  const minBaseChange = Math.max(
    VAT_SANITY_FLOOR_KRONOR,
    (Math.max(current.total, previous.total) * RATE_BASE_CHANGE_MIN_PCT_OF_TOTAL) / 100,
  )
  const anomalies: VatCloseSanityAnomaly[] = []
  for (const { rate } of RATES) {
    const points = roundOre(currentShares[rate] - previousShares[rate])
    const baseChange = roundOre(current.bases[rate] - previous.bases[rate])
    if (Math.abs(points) < RATE_SHARE_SHIFT_MIN_POINTS || Math.abs(baseChange) < minBaseChange) continue
    anomalies.push({
      kind: 'rate_share_shift',
      rate,
      current: currentShares[rate],
      previous: previousShares[rate],
      delta_pct: points,
      current_base: current.bases[rate],
      previous_base: previous.bases[rate],
      message:
        `Andelen av försäljningen med ${rate} % moms ${points > 0 ? 'steg' : 'föll'} från ` +
        `${formatPercent(previousShares[rate])} till ${formatPercent(currentShares[rate])} jämfört med ` +
        `föregående period (beskattningsunderlaget ${baseChange > 0 ? 'ökade' : 'minskade'} med ` +
        `${wholeKronor(Math.abs(baseChange))}): kontrollera att försäljningen har rätt momssats. ` +
        'Har försäljningen faktiskt ändrats är det inget fel.',
    })
  }
  return anomalies
}

function revenueChange(current: number, previous: number): VatCloseSanityAnomaly[] {
  if (previous <= 0 || Math.max(current, previous) < VAT_SANITY_FLOOR_KRONOR) return []
  const deltaPct = roundOre(((current - previous) / previous) * 100)
  const drop = deltaPct < -REVENUE_DROP_PCT
  if (!drop && deltaPct <= REVENUE_SPIKE_PCT) return []
  return [{
    kind: drop ? 'revenue_drop' : 'revenue_spike',
    current,
    previous,
    delta_pct: deltaPct,
    message:
      `Försäljningen i ruta 05 ${drop ? 'föll' : 'steg'} ${formatPercent(Math.abs(deltaPct))} jämfört med ` +
      `föregående period (från ${wholeKronor(previous)} till ${wholeKronor(current)}): ` +
      (drop ? 'bekräfta att alla fakturor är bokförda' : 'kontrollera att inget bokats två gånger'),
  }]
}

/**
 * Compare a momsperiod with the previous period of the same length.
 * `previous` is null when that period could not be read: nothing is compared
 * and `previous_period_compared` says so.
 */
export function compareVatPeriods(current: VatSanityRutor, previous: VatSanityRutor | null): VatCloseSanity {
  const now = periodSales(current)
  const before = previous ? periodSales(previous) : null
  return {
    anomalies: before ? [...rateShareShifts(now, before), ...revenueChange(now.sales, before.sales)] : [],
    ratios: {
      rate_shares: { current: now.shares, previous: before?.shares ?? null },
      output_vat_ratio_25: current.ruta05 > 0 ? roundOre((current.ruta10 / current.ruta05) * 100) : 0,
      output_vat_ratio_12: 0,
      output_vat_ratio_6: 0,
      previous_period_compared: previous !== null,
    },
  }
}
