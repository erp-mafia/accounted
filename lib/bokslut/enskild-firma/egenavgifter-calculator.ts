import type { EfDeclarationItem } from './types'

/** Full egenavgifter rate (born 1959 or later, active business, 7 karensdagar). */
export const EGENAVGIFTER_FULL = 0.2897
/** Reduced rate for pensioners born 1938-1958. */
export const EGENAVGIFTER_PENSIONER = 0.1021
/** Passive business uses SLP rate instead. */
export const SLP_FOR_PASSIVE = 0.2426

/** Schablonavdrag percentages (R43 in NE-bilaga). */
export const SCHABLONAVDRAG_FULL = 0.25
export const SCHABLONAVDRAG_PENSIONER = 0.10
export const SCHABLONAVDRAG_PASSIVE = 0.20

export type EgenavgiftCategory = 'full' | 'pensioner' | 'passive'

export interface EgenavgifterInput {
  /** Överskott före egenavgifter, från NE-bilaga (R41 sum-up basis). */
  surplusBeforeEgenavgifter: number
  /** Vilken kategori. Defaults to 'full'. */
  category?: EgenavgiftCategory
  /** Föregående års schablonavdrag: läggs tillbaka i R40. Defaults to 0. */
  priorYearSchablonavdrag?: number
  /** Föregående års faktiska egenavgifter: dras av i R41. Defaults to 0. */
  priorYearActualCharged?: number
}

export interface EgenavgifterComputation {
  category: EgenavgiftCategory
  surplusBeforeEgenavgifter: number
  priorYearSchablonavdrag: number
  priorYearActualCharged: number
  /** R40 + (-R41) net: surplusBeforeEgenavgifter + priorYearSchablonavdrag - priorYearActualCharged. */
  netSurplusForSchablon: number
  schablonavdragRate: number
  /** R43: schablonavdrag applied to net surplus. */
  schablonavdrag: number
  egenavgifterRate: number
  /** Estimated egenavgifter for the year: for planning only; the exact
   *  amount is set by Skatteverket. */
  estimatedEgenavgifter: number
}

/**
 * Compute the NE-bilaga R40-R43 series for egenavgifter.
 *
 * NEVER produces a journal entry: egenavgifter for enskild firma are paid
 * personally by the owner via Inkomstdeklaration 1, not by the business.
 */
export function calculateEgenavgifter(input: EgenavgifterInput): EfDeclarationItem {
  const category = input.category ?? 'full'
  const r1 = (x: number) => Math.round(x * 100) / 100

  const ratesByCategory = {
    full: { schablon: SCHABLONAVDRAG_FULL, avgifter: EGENAVGIFTER_FULL },
    pensioner: { schablon: SCHABLONAVDRAG_PENSIONER, avgifter: EGENAVGIFTER_PENSIONER },
    passive: { schablon: SCHABLONAVDRAG_PASSIVE, avgifter: SLP_FOR_PASSIVE },
  } as const
  const rates = ratesByCategory[category]

  const priorSchablon = input.priorYearSchablonavdrag ?? 0
  const priorActual = input.priorYearActualCharged ?? 0
  const netSurplus = Math.max(
    0,
    input.surplusBeforeEgenavgifter + priorSchablon - priorActual,
  )
  const schablonavdrag = Math.floor(netSurplus * rates.schablon)
  const estimatedEgenavgifter = Math.round(netSurplus * rates.avgifter)

  const warnings: string[] = []
  if (category === 'full' && netSurplus > 40_000) {
    warnings.push(
      'För aktiv näringsverksamhet med överskott > 40 000 kr ges en automatisk nedsättning av egenavgifterna (7,5 %, max 15 000 kr/år) av Skatteverket.',
    )
  }
  if (input.surplusBeforeEgenavgifter <= 0) {
    warnings.push('Inget överskott att beräkna egenavgifter på.')
  }

  const computation: EgenavgifterComputation = {
    category,
    surplusBeforeEgenavgifter: r1(input.surplusBeforeEgenavgifter),
    priorYearSchablonavdrag: r1(priorSchablon),
    priorYearActualCharged: r1(priorActual),
    netSurplusForSchablon: netSurplus,
    schablonavdragRate: rates.schablon,
    schablonavdrag,
    egenavgifterRate: rates.avgifter,
    estimatedEgenavgifter,
  }

  return {
    kind: 'egenavgifter',
    label: 'Egenavgifter: schablonavdrag',
    description: `Schablonavdrag ${(rates.schablon * 100).toFixed(0)} % av nettoöverskott. Faktiska avgifter beräknas av Skatteverket.`,
    amount: schablonavdrag,
    ne_ruta: 'R43',
    computation: computation as unknown as Record<string, unknown>,
    warnings,
  }
}
