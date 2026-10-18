import { truncateToWholeKronor, wholeKronaPercentage } from '@/lib/money'
import type { EfDeclarationItem } from './types'

/** Expansionsfondsskatt 20.6 % (samma som bolagsskatten). */
export const EXPANSIONSFOND_TAX_RATE = 0.206
/** The fund may be at most 125,94 % of the kapitalunderlag at year-end (IL 34 kap). */
export const EXPANSIONSFOND_MAX_PCT_OF_KAPITALUNDERLAG = 125.94

export interface ExpansionsfondInput {
  /** Kapitalunderlag för expansionsfond vid beskattningsårets utgång
   *  (IL 34 kap). Not the räntefördelning underlag, which is the
   *  previous year's closing balance (IL 33 kap). Undefined when the owner
   *  has not entered it: an ökning is then capped to 0 and the fund cannot
   *  be checked against the cap. */
  kapitalunderlag?: number
  /** The fund at the year's ingång: the basis for this year's change. */
  existingBalance?: number
  /** Önskad ändring (positivt = ökning, negativt = minskning).
   *  Defaults to 0 (no change). */
  desiredChange?: number
  /** NE R35, överskott före ökning av expansionsfond: the ökning (R36) is
   *  "dock högst överskott vid R35". */
  resultBeforeExpansionsfond: number
}

export interface ExpansionsfondComputation {
  kapitalunderlag: number | null
  maxTotalBalance: number | null
  existingBalance: number
  desiredChange: number
  /** NE R35. */
  resultBeforeExpansionsfond: number
  /** The part of the fund above the cap: it must return this year. */
  mandatoryMinskning: number
  /** Signed: + ökning (R36), - minskning (R37). */
  actualChange: number
  newBalance: number
  /** 20.6 % skatt på årets ändring. Tillgodoräknas vid framtida återföring. */
  taxOnChange: number
}

export interface ExpansionsfondResult {
  /** NE R36, whole kronor. */
  r36: number
  /** NE R37, whole kronor. */
  r37: number
  /** The fund at the year's utgång. */
  newBalance: number
  item: EfDeclarationItem | null
}

/**
 * The year's change in expansionsfond (IL 34 kap; NE R35-R37).
 *
 * Ökning: at most the room under 125,94 % of the closing kapitalunderlag and
 * at most the överskott before it (R35). Minskning: what the owner asks for,
 * up to the fund, and never less than the part of the fund above the cap,
 * which must return (Skatteverket, Expansionsfond: "måste i stället återföra
 * det belopp som överstiger gränsen").
 *
 * Mechanism: en enskild näringsidkare betalar 20,6 % expansionsfondsskatt på
 * ökningen. När fonden minskas blir beloppet inkomst av näringsverksamhet och
 * de 20,6 % tillgodoräknas mot årets skatt. Tax-only mechanism, NEVER booked.
 */
export function calculateExpansionsfondChange(input: ExpansionsfondInput): ExpansionsfondResult {
  const known = input.kapitalunderlag !== undefined
  const kapitalunderlag = known ? (input.kapitalunderlag as number) : null
  const maxTotalBalance =
    kapitalunderlag === null
      ? null
      : wholeKronaPercentage(Math.max(0, kapitalunderlag), EXPANSIONSFOND_MAX_PCT_OF_KAPITALUNDERLAG)
  const existingBalance = Math.max(0, truncateToWholeKronor(input.existingBalance ?? 0))
  const desiredChange = truncateToWholeKronor(input.desiredChange ?? 0)
  const r35 = truncateToWholeKronor(input.resultBeforeExpansionsfond)
  const mandatoryMinskning = maxTotalBalance === null ? 0 : Math.max(0, existingBalance - maxTotalBalance)

  if (desiredChange === 0 && mandatoryMinskning === 0) {
    return { r36: 0, r37: 0, newBalance: existingBalance, item: null }
  }

  const warnings: string[] = []
  let actualChange: number
  if (mandatoryMinskning > 0) {
    const asked = desiredChange < 0 ? Math.min(-desiredChange, existingBalance) : 0
    actualChange = -Math.max(mandatoryMinskning, asked)
    warnings.push(
      `Expansionsfonden (${existingBalance} kr) är större än 125,94 % av kapitalunderlaget (${maxTotalBalance} kr). ${mandatoryMinskning} kr måste återföras i år.`,
    )
  } else if (desiredChange > 0) {
    const roomUnderCap = Math.max(0, (maxTotalBalance ?? 0) - existingBalance)
    const roomUnderResult = Math.max(0, r35)
    actualChange = Math.min(desiredChange, roomUnderCap, roomUnderResult)
    if (actualChange < desiredChange) {
      warnings.push(
        roomUnderResult < roomUnderCap
          ? `Ökningen får vara högst överskottet före ökning av expansionsfond (R35, ${roomUnderResult} kr). Begärt belopp (${desiredChange} kr) begränsades till ${actualChange} kr.`
          : `Begärt belopp (${desiredChange} kr) översteg taket på 125,94 % av kapitalunderlaget. Avsättningen begränsades till ${actualChange} kr.`,
      )
    }
  } else {
    actualChange = -Math.min(-desiredChange, existingBalance)
    if (-actualChange < -desiredChange) {
      warnings.push(`Återföringen begränsades till befintligt saldo (${existingBalance} kr).`)
    }
  }

  const newBalance = existingBalance + actualChange
  // The direction is what was asked for: an ökning capped to 0 is still an
  // ökning (R36), not a minskning. A minskning the cap forces is R37.
  const isIncrease = mandatoryMinskning === 0 && desiredChange > 0
  const taxOnChange = Math.round(actualChange * EXPANSIONSFOND_TAX_RATE)
  const amount = Math.abs(actualChange)

  const computation: ExpansionsfondComputation = {
    kapitalunderlag,
    maxTotalBalance,
    existingBalance,
    desiredChange,
    resultBeforeExpansionsfond: r35,
    mandatoryMinskning,
    actualChange,
    newBalance,
    taxOnChange,
  }

  return {
    r36: isIncrease ? amount : 0,
    r37: isIncrease ? 0 : amount,
    newBalance,
    item: {
      kind: isIncrease ? 'expansionsfond_avsattning' : 'expansionsfond_ateforing',
      label: isIncrease ? 'Expansionsfond: ökning' : 'Expansionsfond: minskning',
      description: isIncrease
        ? `Ökning ${amount} kr i NE R36, förs även till Inkomstdeklaration 1 punkt 12.1. Expansionsfondsskatt 20,6 % (${Math.abs(taxOnChange)} kr) betalas i år.`
        : `Minskning ${amount} kr i NE R37, förs även till Inkomstdeklaration 1 punkt 12.2. Tidigare betald expansionsfondsskatt (${Math.abs(taxOnChange)} kr) tillgodoräknas.`,
      amount,
      ne_ruta: isIncrease ? 'R36' : 'R37',
      computation: computation as unknown as Record<string, unknown>,
      warnings,
    },
  }
}
