import { roundOre, wholeKronaPercentage } from '@/lib/money'
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
  /**
   * NE R42, överskott före årets avdrag för egenavgifter: R35 - R36 + R37
   * - R38 - R39 + R40 - R41. The schablonavdrag in R43 is at most 25 % of
   * "det resultat som näringsverksamheten visar före ruta R43"
   * (Skatteverket, NE hjälptext R43). The preview computes it.
   */
  surplusBeforeEgenavgifter: number
  /** Vilken kategori. Defaults to 'full'. */
  category?: EgenavgiftCategory
}

export interface EgenavgifterComputation {
  category: EgenavgiftCategory
  /** NE R42, signed. */
  surplusBeforeEgenavgifter: number
  /** R42 when positive, else 0: what the schablon applies to. */
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
 * NE R43, the year's schablonavdrag for egenavgifter, from R42.
 *
 * NEVER produces a journal entry: egenavgifter for enskild firma are paid
 * personally by the owner via Inkomstdeklaration 1, not by the business.
 */
export function calculateEgenavgifter(input: EgenavgifterInput): EfDeclarationItem {
  const category = input.category ?? 'full'

  const ratesByCategory = {
    full: { schablon: SCHABLONAVDRAG_FULL, avgifter: EGENAVGIFTER_FULL },
    pensioner: { schablon: SCHABLONAVDRAG_PENSIONER, avgifter: EGENAVGIFTER_PENSIONER },
    passive: { schablon: SCHABLONAVDRAG_PASSIVE, avgifter: SLP_FOR_PASSIVE },
  } as const
  const rates = ratesByCategory[category]

  // roundOre before either use below: a caller's sum of doubles can drift
  // just under a whole krona and take the schablonavdrag a krona low (#2597).
  const r42 = roundOre(input.surplusBeforeEgenavgifter)
  const netSurplus = Math.max(0, r42)
  // Öre dropped (SFL 22 kap 1 §), computed in integer öre so float noise
  // cannot lose a krona.
  const schablonavdrag = wholeKronaPercentage(netSurplus, Math.round(rates.schablon * 100))
  const estimatedEgenavgifter = Math.round(netSurplus * rates.avgifter)

  const warnings: string[] = []
  if (category === 'full' && netSurplus > 40_000) {
    warnings.push(
      'För aktiv näringsverksamhet med överskott > 40 000 kr ges en automatisk nedsättning av egenavgifterna (7,5 %, max 15 000 kr/år) av Skatteverket.',
    )
  }
  if (r42 <= 0) {
    warnings.push('Inget överskott att beräkna egenavgifter på.')
  }

  const computation: EgenavgifterComputation = {
    category,
    surplusBeforeEgenavgifter: r42,
    netSurplusForSchablon: netSurplus,
    schablonavdragRate: rates.schablon,
    schablonavdrag,
    egenavgifterRate: rates.avgifter,
    estimatedEgenavgifter,
  }

  return {
    kind: 'egenavgifter',
    label: 'Egenavgifter: schablonavdrag',
    description: `Schablonavdrag ${Math.round(rates.schablon * 100)} % av överskottet före avdrag för egenavgifter (NE R42). Fylls i i R43. Faktiska avgifter beräknas av Skatteverket.`,
    amount: schablonavdrag,
    ne_ruta: 'R43',
    computation: computation as unknown as Record<string, unknown>,
    warnings,
  }
}
