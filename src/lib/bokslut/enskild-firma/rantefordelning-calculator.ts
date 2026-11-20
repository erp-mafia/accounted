import { truncateToWholeKronor, wholeKronaPercentage } from '@/lib/money'
import type { EfDeclarationItem } from './types'

/**
 * Statslåneräntan 30 november the year before the inkomstår, in percent,
 * keyed by inkomstår: the calendar year the beskattningsår ends in (IL 33
 * kap). Raw values, because räntefördelning has its own floors below. The AB
 * schablonintäkt table (reserves/periodiseringsfond-service.ts) carries the
 * same figures already floored at 0,5 %, so it cannot serve here.
 *
 * Sources: swedish-ef-skatteplanering, rantefordelning-planning.md "Rates by
 * year"; Skatteverket, Räntefördelning (7,96 % and 2,96 % for inkomstår
 * 2025). A year missing here is never guessed: no räntefördelning is
 * computed and the preview says why. Add the next year when the 30 november
 * figure is published.
 */
export const RANTEFORDELNING_SLR_PCT_BY_INCOME_YEAR: Readonly<Record<number, number>> = {
  2024: 2.62,
  2025: 1.96,
  2026: 2.55,
}

/** Positiv räntefördelning: SLR + 6 procentenheter, the SLR never below 0. */
export const POSITIVE_RANTEFORDELNING_ADD_PCT = 6
/** Negativ räntefördelning: SLR + 1 procentenhet, the SLR never below 0,5 %. */
export const NEGATIVE_RANTEFORDELNING_ADD_PCT = 1

/**
 * Beskattningsår that begin on or after this date follow prop. 2024/25:1:
 * positive räntefördelning from a kapitalunderlag of 0 kr, negative only
 * below -500 000 kr, and a sparat fördelningsbelopp usable whatever the
 * kapitalunderlag. Earlier beskattningsår keep the ±50 000 kr limits.
 */
export const RANTEFORDELNING_REFORM_START = '2025-01-01'

/** Negativ räntefördelning is mandatory below this kapitalunderlag (from 2025). */
export const NEGATIVE_THRESHOLD = -500_000
/** The limits for a beskattningsår that began before 2025. */
export const PRE_2025_POSITIVE_THRESHOLD = 50_000
export const PRE_2025_NEGATIVE_THRESHOLD = -50_000

export interface RantefordelningInput {
  /**
   * Kapitalunderlag för räntefördelning at the previous year's utgång, as on
   * Skatteverket's hjälpblankett SKV 2196: after every adjustment, the
   * addition of sparat fördelningsbelopp included. Never added again here.
   */
  kapitalunderlag: number
  /** Sparat fördelningsbelopp from earlier years (last year's NE, Övriga uppgifter). */
  sparatFordelningsbelopp?: number
  /** NE R29, överskott före räntefördelning: R30 may never exceed it. */
  resultBeforeRantefordelning: number
  /** The beskattningsår (ISO dates): the inkomstår, the limits and the jämkning follow from it. */
  periodStart: string
  periodEnd: string
}

export interface RantefordelningResult {
  /** NE R30, whole kronor. */
  r30: number
  /** NE R31, whole kronor. */
  r31: number
  /** Positivt fördelningsbelopp som sparas till nästa beskattningsår (NE Övriga uppgifter, fältkod 8011). */
  sparatTillNastaAr: number
  /**
   * The form's footnote 4: the kapitalunderlag (8009/8010) is given by one
   * who reported räntefördelning in R30 or R31, or whose sparat
   * fördelningsbelopp grew this year.
   */
  kapitalunderlagRequired: boolean
  /** The R30 and R31 cards. */
  items: EfDeclarationItem[]
  /** Why no räntefördelning was computed (a rate not yet known). */
  warnings: string[]
}

/** Calendar months the beskattningsår spans, its first and last month included. */
export function beskattningsarMonths(periodStart: string, periodEnd: string): number {
  const [startYear, startMonth] = periodStart.split('-').map(Number)
  const [endYear, endMonth] = periodEnd.split('-').map(Number)
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1
}

function formatKronor(amount: number): string {
  return amount.toLocaleString('sv-SE')
}

function formatPct(pct: number): string {
  return pct.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Fördelningsbelopp: the rate on the kapitalunderlag, jämkat for a
 * beskattningsår longer or shorter than twelve months (Skatteverket,
 * Räntefördelning: "120 000 × 9 ÷ 12 = 90 000"), öre dropped (SFL 22 kap
 * 1 §).
 */
function fordelningsbelopp(base: number, ratePct: number, months: number): number {
  return wholeKronaPercentage(months === 12 ? base : (base * months) / 12, ratePct)
}

const NONE: RantefordelningResult = {
  r30: 0,
  r31: 0,
  sparatTillNastaAr: 0,
  kapitalunderlagRequired: false,
  items: [],
  warnings: [],
}

/**
 * Räntefördelning for an enskild firma (IL 33 kap; NE R29-R31).
 *
 * Positive: this year's fördelningsbelopp plus the sparat fördelningsbelopp,
 * at most the överskott before räntefördelning ("dock högst överskott vid
 * R29" on the form). What is not used is saved to the next year. Negative:
 * mandatory below the threshold, whatever the result.
 *
 * NEVER produces a journal entry: räntefördelning is declaration-only.
 */
export function calculateRantefordelning(input: RantefordelningInput): RantefordelningResult {
  const kapitalunderlag = input.kapitalunderlag
  const sparatIn = Math.max(0, truncateToWholeKronor(input.sparatFordelningsbelopp ?? 0))
  if (kapitalunderlag === 0 && sparatIn === 0) return NONE

  const incomeYear = parseInt(input.periodEnd.slice(0, 4), 10)
  const slrPct = RANTEFORDELNING_SLR_PCT_BY_INCOME_YEAR[incomeYear]
  if (slrPct === undefined) {
    // Between -500 000 and 0 kr with nothing saved there is no
    // räntefördelning whatever the rate, so there is nothing to warn about.
    if (kapitalunderlag < 0 && kapitalunderlag >= NEGATIVE_THRESHOLD && sparatIn === 0) return NONE
    return {
      ...NONE,
      warnings: [
        `Räntesatsen för räntefördelning inkomstår ${incomeYear} är inte känd ännu (statslåneräntan 30 november ${incomeYear - 1}). Räntefördelning beräknas inte.`,
      ],
    }
  }
  const months = beskattningsarMonths(input.periodStart, input.periodEnd)
  const afterReform = input.periodStart >= RANTEFORDELNING_REFORM_START
  const positivePct = Math.max(0, slrPct) + POSITIVE_RANTEFORDELNING_ADD_PCT
  const negativePct = Math.max(0.5, slrPct) + NEGATIVE_RANTEFORDELNING_ADD_PCT
  const negativeThreshold = afterReform ? NEGATIVE_THRESHOLD : PRE_2025_NEGATIVE_THRESHOLD

  const positiveAllowed = afterReform ? kapitalunderlag >= 0 : kapitalunderlag > PRE_2025_POSITIVE_THRESHOLD
  const arsBelopp = positiveAllowed ? fordelningsbelopp(kapitalunderlag, positivePct, months) : 0
  // The skill gives the pre-2025 rule for a sparat belopp only as "not
  // against a negative kapitalunderlag": such a year leaves it unused (and
  // saved) rather than guessing.
  const sparatUsable = afterReform ? sparatIn : 0
  const r30 = Math.min(
    arsBelopp + sparatUsable,
    Math.max(0, truncateToWholeKronor(input.resultBeforeRantefordelning)),
  )
  const sparatTillNastaAr = arsBelopp + sparatIn - r30
  const negativeMandatory = kapitalunderlag < negativeThreshold
  const r31 = negativeMandatory ? fordelningsbelopp(Math.abs(kapitalunderlag), negativePct, months) : 0

  const jamkning = months === 12 ? '' : `, jämkat till ${months} av 12 månader`
  const items: EfDeclarationItem[] = []

  if (arsBelopp > 0 || sparatIn > 0) {
    const basis = [
      arsBelopp > 0
        ? `${formatPct(positivePct)} % på kapitalunderlaget ${formatKronor(kapitalunderlag)} kr${jamkning} ger ${formatKronor(arsBelopp)} kr`
        : null,
      sparatUsable > 0 ? `sparat fördelningsbelopp ${formatKronor(sparatUsable)} kr` : null,
    ].filter((part): part is string => part !== null)
    const warnings: string[] = []
    if (!afterReform && sparatIn > 0) {
      warnings.push(
        'Sparat fördelningsbelopp är inte använt: beskattningsåret började före 2025, då andra regler gällde. Kontrollera själv om det får användas.',
      )
    }
    if (sparatTillNastaAr > 0) {
      warnings.push(
        `${formatKronor(sparatTillNastaAr)} kr sparas till nästa år. Fyll i det under Övriga uppgifter: "Positivt fördelningsbelopp som sparas till nästa beskattningsår".`,
      )
    }
    items.push({
      kind: 'rantefordelning_positive',
      label: 'Positiv räntefördelning (frivillig)',
      description: `${basis.length > 0 ? `${basis.join(', plus ')}. ` : ''}Avdrag i NE R30, högst överskottet före räntefördelning (R29). Samma belopp tas upp som inkomst av kapital i Inkomstdeklaration 1 punkt 11.1.`,
      amount: r30,
      ne_ruta: 'R30',
      computation: {
        incomeYear,
        months,
        slrPct,
        positiveRatePct: positivePct,
        kapitalunderlag,
        arsFordelningsbelopp: arsBelopp,
        sparatFordelningsbelopp: sparatIn,
        resultBeforeRantefordelning: input.resultBeforeRantefordelning,
        r30,
        sparatTillNastaAr,
      },
      warnings,
    })
  }

  if (negativeMandatory) {
    items.push({
      kind: 'rantefordelning_negative',
      label: 'Negativ räntefördelning (obligatorisk)',
      description: `${formatPct(negativePct)} % på kapitalunderskottet ${formatKronor(Math.abs(kapitalunderlag))} kr${jamkning}. Läggs till resultatet i NE R31; samma belopp dras av i inkomst av kapital i Inkomstdeklaration 1 punkt 11.2.`,
      amount: r31,
      ne_ruta: 'R31',
      computation: { incomeYear, months, slrPct, negativeRatePct: negativePct, kapitalunderlag, r31 },
      warnings: [
        `Negativ räntefördelning är obligatorisk när kapitalunderlaget är mer negativt än ${afterReform ? '-500 000' : '-50 000'} kr.`,
      ],
    })
  }

  return {
    r30,
    r31,
    sparatTillNastaAr,
    kapitalunderlagRequired: r30 > 0 || r31 > 0 || sparatTillNastaAr > sparatIn,
    items,
    warnings: [],
  }
}
