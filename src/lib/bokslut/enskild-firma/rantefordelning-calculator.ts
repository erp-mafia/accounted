import type { EfDeclarationItem } from './types'

/** Räntefördelning rates per IL 33 kap. Statslåneräntan from 30 november
 *  året före, plus tilläggspoäng. SLR for 2026 = 2.55 %. */
export const POSITIVE_RANTEFORDELNING_ADD = 0.06 // SLR + 6 pe → 8.55 % för 2026
export const NEGATIVE_RANTEFORDELNING_ADD = 0.01 // SLR + 1 pe → 3.55 % för 2026

/** Negativ räntefördelning triggas vid kapitalunderlag mer negativt än
 *  -500 000 kr (IL 33 kap 4 §). */
export const NEGATIVE_THRESHOLD = -500_000

export interface RantefordelningInput {
  /** Justerat eget kapital i näringsverksamheten vid föregående års utgång.
   *  Positivt = kapitalöverskott (positiv räntefördelning möjlig); negativt
   *  = kapitalunderskott (negativ räntefördelning obligatorisk > -500 000). */
  kapitalunderlag: number
  /** SLR 30 november föregående år. Default = 0.0255 (för inkomstår 2026,
   *  SLR 2025-11-30 = 2,55 %). Override per år tills Riksbanken-integrationen
   *  ligger på plats. */
  slrRate?: number
}

export interface RantefordelningComputation {
  kapitalunderlag: number
  slrRate: number
  positiveRate: number
  positiveBase: number
  /** Maximalt belopp att räntefördela till kapital. Voluntarily. */
  positiveAmount: number
  negativeRate: number
  negativeBase: number
  /** Obligatorisk negativ räntefördelning (> -500 000). */
  negativeAmount: number
}

/**
 * Compute räntefördelning for an enskild firma. Returns at most one of
 * positive or negative: the two are mutually exclusive based on sign of
 * kapitalunderlag.
 *
 * NEVER produces a journal entry: räntefördelning is a tax-only mechanism
 * (Inkomstdeklaration 1, kapitalinkomst-fältet).
 */
export function calculateRantefordelning(
  input: RantefordelningInput,
): EfDeclarationItem | null {
  const slrRate = input.slrRate ?? 0.0255
  const positiveRate = Math.max(0.005, slrRate + POSITIVE_RANTEFORDELNING_ADD)
  const negativeRate = Math.max(0.005, slrRate + NEGATIVE_RANTEFORDELNING_ADD)

  const isPositive = input.kapitalunderlag > 0
  const isNegativeMandatory = input.kapitalunderlag < NEGATIVE_THRESHOLD

  if (!isPositive && !isNegativeMandatory) {
    return null
  }

  // Use Math.round (not floor/ceil) to absorb IEEE 754 representation error:
  // 1 000 000 × (0.0255 + 0.06) evaluates to 85499.99999... in JS, and floor()
  // would shave a krona off the user's deduction for a non-economic reason.
  const computation: RantefordelningComputation = {
    kapitalunderlag: input.kapitalunderlag,
    slrRate,
    positiveRate,
    positiveBase: isPositive ? input.kapitalunderlag : 0,
    positiveAmount: isPositive ? Math.round(input.kapitalunderlag * positiveRate) : 0,
    negativeRate,
    negativeBase: isNegativeMandatory ? Math.abs(input.kapitalunderlag) : 0,
    negativeAmount: isNegativeMandatory
      ? Math.round(Math.abs(input.kapitalunderlag) * negativeRate)
      : 0,
  }

  if (isPositive) {
    return {
      kind: 'rantefordelning_positive',
      label: 'Positiv räntefördelning (frivillig)',
      description: `${(positiveRate * 100).toFixed(2)} % på kapitalunderlag ${input.kapitalunderlag.toLocaleString('sv-SE')} kr. Avdrag i NE R30; motsvarande belopp redovisas som inkomst av kapital på Inkomstdeklaration 1 (T4).`,
      amount: computation.positiveAmount,
      // NE-bilagan har bara fältet R30. INK1 är ett separat formulär. Tidigare
      // sammanslagningen 'R30 / INK1 kapital' fick användare att leta efter ett
      // ruta-namn som inte finns på NE.
      ne_ruta: 'R30 (avdrag i näringsverksamhet)',
      computation: computation as unknown as Record<string, unknown>,
      warnings: [],
    }
  }

  return {
    kind: 'rantefordelning_negative',
    label: 'Negativ räntefördelning (obligatorisk)',
    description: `${(negativeRate * 100).toFixed(2)} % på kapitalunderskott. Tillägg till resultat i näringsverksamhet eftersom verksamheten lånat av privata medel.`,
    amount: computation.negativeAmount,
    ne_ruta: 'R30 (tillägg till resultat)',
    computation: computation as unknown as Record<string, unknown>,
    warnings: [
      'Negativ räntefördelning är obligatorisk när kapitalunderlaget är mer negativt än -500 000 kr.',
    ],
  }
}
