import type { EfDeclarationItem } from './types'

/** Expansionsfondsskatt 20.6 % (samma som bolagsskatten). */
export const EXPANSIONSFOND_TAX_RATE = 0.206
/** Max avsättning = 125,94 % av kapitalunderlag (IL 34 kap). */
export const EXPANSIONSFOND_MAX_OF_KAPITALUNDERLAG = 1.2594

export interface ExpansionsfondInput {
  /** Kapitalunderlag vid årets slut (samma underlag som för positiv
   *  räntefördelning, IL 34 kap 6 §). */
  kapitalunderlag: number
  /** Tidigare kvarstående avsättning till expansionsfond: utgör utgångsläget
   *  för årets bedömning. */
  existingBalance?: number
  /** Önskad ändring (positivt = avsättning, negativt = återföring).
   *  Defaults to 0 (no change). */
  desiredChange?: number
}

export interface ExpansionsfondComputation {
  kapitalunderlag: number
  maxTotalBalance: number
  existingBalance: number
  desiredChange: number
  /** Begränsat ändringsbelopp efter takkontroll. */
  actualChange: number
  newBalance: number
  /** 20.6 % skatt på årets nettoökning. Tillgodoräknas vid framtida återföring. */
  taxOnChange: number
}

/**
 * Compute the change in expansionsfond.
 *
 * Mechanism: en enskild näringsidkare betalar 20,6 % expansionsfondsskatt på
 * avsatt belopp ENA året. När fonden återförs blir beloppet inkomst av
 * näringsverksamhet samma år som återföringen: men de 20,6 % redan betalat
 * tillgodoräknas mot årets skatt. Tax-only mechanism, NEVER booked.
 */
export function calculateExpansionsfondChange(
  input: ExpansionsfondInput,
): EfDeclarationItem | null {
  const maxTotalBalance = Math.floor(
    Math.max(0, input.kapitalunderlag) * EXPANSIONSFOND_MAX_OF_KAPITALUNDERLAG,
  )
  const existingBalance = Math.max(0, Math.floor(input.existingBalance ?? 0))
  const desiredChange = Math.round(input.desiredChange ?? 0)
  if (desiredChange === 0) return null

  let actualChange = desiredChange
  // Cap avsättning so the new total doesn't exceed the kapitalunderlag-based cap.
  if (desiredChange > 0) {
    const room = Math.max(0, maxTotalBalance - existingBalance)
    actualChange = Math.min(desiredChange, room)
  } else {
    // Återföring can't go below zero.
    actualChange = -Math.min(Math.abs(desiredChange), existingBalance)
  }
  const newBalance = existingBalance + actualChange
  const taxOnChange = Math.round(actualChange * EXPANSIONSFOND_TAX_RATE)

  const warnings: string[] = []
  if (desiredChange > 0 && actualChange < desiredChange) {
    warnings.push(
      `Begärt belopp (${desiredChange} kr) översteg taket på 125,94 % av kapitalunderlaget. Avsättningen begränsades till ${actualChange} kr.`,
    )
  }
  if (desiredChange < 0 && Math.abs(actualChange) < Math.abs(desiredChange)) {
    warnings.push(
      `Återföringen begränsades till befintligt saldo (${existingBalance} kr).`,
    )
  }

  const computation: ExpansionsfondComputation = {
    kapitalunderlag: input.kapitalunderlag,
    maxTotalBalance,
    existingBalance,
    desiredChange,
    actualChange,
    newBalance,
    taxOnChange,
  }

  return {
    kind: actualChange > 0 ? 'expansionsfond_avsattning' : 'expansionsfond_ateforing',
    label:
      actualChange > 0
        ? 'Expansionsfond: avsättning'
        : 'Expansionsfond: återföring',
    description:
      actualChange > 0
        ? `Avsättning ${actualChange} kr. Skatt 20,6 % (${Math.abs(taxOnChange)} kr) betalas i år.`
        : `Återföring ${Math.abs(actualChange)} kr. Tidigare betald skatt (${Math.abs(taxOnChange)} kr) tillgodoräknas.`,
    amount: Math.abs(actualChange),
    ne_ruta: actualChange > 0 ? 'R34' : 'R33',
    computation: computation as unknown as Record<string, unknown>,
    warnings,
  }
}
