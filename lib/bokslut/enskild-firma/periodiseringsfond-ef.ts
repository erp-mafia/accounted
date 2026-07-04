import type { EfDeclarationItem } from './types'

/** EF får sätta av max 30 % av överskott (vs 25 % för AB). */
export const PFOND_EF_RATE = 0.30
/** Same 6-year mandatory reversal as AB (IL 30 kap 7 §). */
export const PFOND_EF_MAX_HOLD_YEARS = 6

export interface EfPfondAvsattningInput {
  /** Skattemässigt överskott efter alla andra justeringar. */
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
    description: `Max 30 % av skattemässigt överskott. Sätts av i NE-bilaga R30 (uppskjuten skatt). Bokförs inte.`,
    amount,
    ne_ruta: 'R30',
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

export interface EfPfondAteforingInput {
  existingFonder: EfExistingFond[]
  closingYear: number
  /** Per-cohort återföringsbelopp (kan vara delar av saldot). Mandatory
   *  cohorts återförs alltid till fullo. */
  returns?: Record<number, number>
}

export function proposeEfPfondAteforing(
  input: EfPfondAteforingInput,
): EfDeclarationItem[] {
  const items: EfDeclarationItem[] = []
  for (const fond of input.existingFonder) {
    const isMandatory = fond.cohort_year + PFOND_EF_MAX_HOLD_YEARS <= input.closingYear
    const requested = input.returns?.[fond.cohort_year] ?? 0
    const amount = isMandatory ? fond.balance : Math.min(Math.max(0, requested), fond.balance)
    if (amount === 0) continue
    items.push({
      kind: 'periodiseringsfond_ateforing',
      label: `Periodiseringsfond ${fond.cohort_year}: återföring`,
      description: 'Återförs i NE-bilaga R29.',
      amount,
      ne_ruta: 'R29',
      computation: {
        cohort_year: fond.cohort_year,
        opening_balance: fond.balance,
        return_amount: amount,
        was_mandatory: isMandatory,
      },
      warnings: isMandatory
        ? [`Periodiseringsfond ${fond.cohort_year} har nått 6-årsgränsen och måste återföras.`]
        : [],
    })
  }
  return items
}
