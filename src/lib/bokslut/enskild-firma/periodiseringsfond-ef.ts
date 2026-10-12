import { roundOre } from '@/lib/money'
import type { EfDeclarationItem } from './types'

/** EF får sätta av max 30 % av överskott (vs 25 % för AB). */
export const PFOND_EF_RATE = 0.30
/** Same 6-year mandatory reversal as AB (IL 30 kap 7 §). */
export const PFOND_EF_MAX_HOLD_YEARS = 6

export interface EfPfondAvsattningInput {
  /** NE R33: the för periodiseringsfond justerade resultatet (IL 30 kap
   *  6 §), i.e. after räntefördelning and återföring, before this
   *  avsättning, expansionsfond and any avdrag för egenavgifter. */
  surplus: number
  /** Året då avsättningen görs. */
  fiscalYear: number
  /** Önskat belopp; defaults to maximum. */
  desiredAmount?: number
}

export function proposeEfPfondAvsattning(input: EfPfondAvsattningInput): EfDeclarationItem | null {
  const base = Math.max(0, Math.floor(input.surplus))
  const max = Math.floor(base * PFOND_EF_RATE)
  const desired = Math.max(0, Math.floor(input.desiredAmount ?? max))
  const amount = Math.min(desired, max)
  if (amount === 0) return null

  const warnings: string[] = []
  if (desired > max) {
    warnings.push(
      `Begärt belopp (${desired} kr) översteg 30 %-taket. Avsättningen begränsades till ${max} kr.`,
    )
  }

  return {
    kind: 'periodiseringsfond_avsattning',
    label: `Periodiseringsfond ${input.fiscalYear}: avsättning`,
    description: `Max 30 % av överskottet före avsättning (NE-bilaga R33). Sätts av i NE-bilaga R34 (uppskjuten skatt). Bokförs inte.`,
    amount,
    ne_ruta: 'R34',
    computation: {
      surplus: input.surplus,
      rate: PFOND_EF_RATE,
      maxAmount: max,
      desiredAmount: desired,
      actualAmount: amount,
      fiscalYear: input.fiscalYear,
    },
    warnings,
  }
}

export interface EfExistingFond {
  /** Vilket år fonden avsattes. */
  cohort_year: number
  /** Aktuellt saldo (positivt). */
  balance: number
}

/**
 * The last beskattningsår a fund may stay: the sixth year after the year of
 * the avsättning (IL 30 kap 7 §).
 */
export function efPfondLatestReturnYear(cohortYear: number): number {
  return cohortYear + PFOND_EF_MAX_HOLD_YEARS
}

/**
 * Where a fund stands in the closing year: `mandatory` reaches its last year
 * now, `overdue` passed it in an earlier year, `optional` may still stay, and
 * `invalid` is not an earlier year's fund at all (this year's avsättning is
 * computed separately).
 */
export type EfFondStatus = 'mandatory' | 'overdue' | 'optional' | 'invalid'

export interface EfFondState extends EfExistingFond {
  latest_return_year: number
  status: EfFondStatus
}

/**
 * Oldest first, because återföring takes the oldest fund first (NE-bilaga
 * R32). One fund per avsättningsår: a repeated year is summed rather than
 * dropped, and a fund without a positive balance has nothing to return.
 */
export function classifyEfPfonder(fonder: EfExistingFond[], closingYear: number): EfFondState[] {
  const byYear = new Map<number, number>()
  for (const fond of fonder) {
    if (!Number.isInteger(fond.cohort_year) || !(fond.balance > 0)) continue
    byYear.set(fond.cohort_year, roundOre((byYear.get(fond.cohort_year) ?? 0) + fond.balance))
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([cohort_year, balance]) => {
      const latest = efPfondLatestReturnYear(cohort_year)
      const status: EfFondStatus =
        cohort_year >= closingYear
          ? 'invalid'
          : latest < closingYear
            ? 'overdue'
            : latest === closingYear
              ? 'mandatory'
              : 'optional'
      return { cohort_year, balance, latest_return_year: latest, status }
    })
}

export interface EfPfondAteforingInput {
  existingFonder: EfExistingFond[]
  closingYear: number
  /**
   * Frivillig återföring utöver det som måste återföras, taken from the
   * oldest fund first. Funds in or past their last year always return in
   * full.
   */
  voluntaryAmount?: number
}

export function proposeEfPfondAteforing(
  input: EfPfondAteforingInput,
): EfDeclarationItem[] {
  const items: EfDeclarationItem[] = []
  let voluntaryLeft = Math.max(0, roundOre(input.voluntaryAmount ?? 0))
  for (const fond of classifyEfPfonder(input.existingFonder, input.closingYear)) {
    if (fond.status === 'invalid') continue
    const isMandatory = fond.status !== 'optional'
    let amount = fond.balance
    if (!isMandatory) {
      amount = Math.min(voluntaryLeft, fond.balance)
      voluntaryLeft = roundOre(voluntaryLeft - amount)
    }
    if (amount <= 0) continue
    items.push({
      kind: 'periodiseringsfond_ateforing',
      label: `Periodiseringsfond ${fond.cohort_year}: återföring`,
      description: 'Återförs i NE-bilaga R32.',
      amount,
      ne_ruta: 'R32',
      computation: {
        cohort_year: fond.cohort_year,
        opening_balance: fond.balance,
        return_amount: amount,
        latest_return_year: fond.latest_return_year,
        was_mandatory: isMandatory,
      },
      warnings:
        fond.status === 'mandatory'
          ? [`Periodiseringsfond ${fond.cohort_year} har nått 6-årsgränsen och måste återföras.`]
          : fond.status === 'overdue'
            ? [
                `Periodiseringsfond ${fond.cohort_year} skulle ha återförts senast i ${fond.latest_return_year} års deklaration. Kontrollera att den inte redan har återförts.`,
              ]
            : [],
    })
  }
  return items
}
