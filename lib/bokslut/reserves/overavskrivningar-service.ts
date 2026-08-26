import type { ProposedDisposition } from '../types'
import { roundOre } from '@/lib/money'

/** 30-rule (huvudregel, IL 18 kap 13 §): restvärde minst 70 % av ingående
 *  bokfört värde plus årets anskaffningar minus årets försäljningar. */
export const OVERAVSKRIVNING_30_RULE = 0.7

/** 20-rule (kompletteringsregel, IL 18 kap 17 §): restvärde minst 0 % efter
 *  5 år (20 % avskrivning per år, raklinje). */
export const OVERAVSKRIVNING_20_RULE_YEARS = 5

export interface Compute30RuleInput {
  /** IB skattemässigt värde maskiner & inventarier. */
  openingBookValue: number
  /** Årets anskaffningar (debet på anskaffningskonto, t.ex. 1220). */
  additions: number
  /** Försäljningsvärde och utrangering av tillgångar (kredit på anskaffningskonto). */
  disposals: number
  /** Räkenskapsperiodens längd. 30 % proportioneras för perioder som inte är 12 månader. */
  fiscalPeriodMonths?: number
}

export interface Compute20RuleInput {
  /** Anskaffningskostnad per anskaffningsår, från innevarande år minus 4 till
   *  innevarande år. Index 0 = innevarande år. */
  acquisitionCostByYearOffset: [number, number, number, number, number]
}

/**
 * 30-regeln: skattemässigt lägsta restvärde = 70 % × (IB + årets anskaffningar − årets avyttringar).
 * Maximalt skattemässigt avskrivningsbart belopp = avskrivningsunderlag − restvärde.
 */
export function compute30Rule(input: Compute30RuleInput): {
  base: number
  minimumResidual: number
  maxAllowedAccumulated: number
} {
  const base = Math.max(0, input.openingBookValue + input.additions - input.disposals)
  const periodMonths = input.fiscalPeriodMonths ?? 12
  const depreciationRate = Math.min(1, 0.3 * (periodMonths / 12))
  const minimumResidual = roundOre(base * (1 - depreciationRate))
  return {
    base,
    minimumResidual,
    maxAllowedAccumulated: roundOre(base - minimumResidual),
  }
}

/**
 * 20-regeln: varje årsanskaffning får skrivas av med 20 % under 5 år. Lägsta
 * skattemässigt restvärde är anskaffningskostnaden minus 20 % per tolvmånadersperiod,
 * inklusive anskaffningsperioden.
 *
 * Returns the allowed depreciation if 20-rule is used as the sole basis,
 * computed against ALL still-active 20-rule cohorts.
 */
export function compute20Rule(input: Compute20RuleInput): {
  minimumResidual: number
} {
  return compute20RuleForFiscalPeriods({
    acquisitionCostByPeriod: input.acquisitionCostByYearOffset,
    fiscalPeriodMonths: [12, 12, 12, 12, 12],
  })
}

export interface Compute20RuleForFiscalPeriodsInput {
  /** Anskaffningskostnad per period. Index 0 är innevarande period. */
  acquisitionCostByPeriod: number[]
  /** Periodlängd per motsvarande period, nyaste först. */
  fiscalPeriodMonths: number[]
}

/**
 * Kompletteringsregeln writes off 20 % per twelve fiscal months, including
 * the acquisition period. Supplying actual period lengths handles shortened
 * and extended fiscal years without shifting the acquisition cohort by a year.
 */
export function compute20RuleForFiscalPeriods(
  input: Compute20RuleForFiscalPeriodsInput,
): { minimumResidual: number } {
  let residual = 0
  for (let offset = 0; offset < input.acquisitionCostByPeriod.length; offset++) {
    const cost = input.acquisitionCostByPeriod[offset] ?? 0
    const elapsedMonths = input.fiscalPeriodMonths
      .slice(0, offset + 1)
      .reduce((sum, months) => sum + months, 0)
    const depreciatedFraction = Math.min(1, elapsedMonths / 60)
    residual += cost * (1 - depreciatedFraction)
  }
  return { minimumResidual: roundOre(residual) }
}

/**
 * Pick the rule that gives the lowest restvärde (highest allowed deduction)
 * per IL 18 kap 13-17 §§: företaget får välja den fördelaktigaste regeln
 * varje år.
 */
export function pickLowerResidual(
  rule30: ReturnType<typeof compute30Rule>,
  rule20: ReturnType<typeof compute20Rule>,
): { residual: number; rule: '30-regeln' | '20-regeln' } {
  if (rule20.minimumResidual < rule30.minimumResidual) {
    return { residual: rule20.minimumResidual, rule: '20-regeln' }
  }
  return { residual: rule30.minimumResidual, rule: '30-regeln' }
}

/**
 * BAS account pairs for överavskrivningar by asset category. The 88xx
 * "förändring" account always pairs with its matching 21xx "ackumulerade"
 * account so the verifikation stays balanced and flows into the right INK2R
 * field via the SRU mapping.
 *
 *   - 8853 / 2153: maskiner & inventarier (IL 18 kap, dominant K2 case)
 *   - 8852 / 2152: byggnader (IL 19 kap, rare in SME)
 *   - 8851 / 2151: immateriella tillgångar (IL 16 kap, even rarer)
 *   - 8850 / 2150: samlingskonto för grupp
 */
export const OVERAVSKRIVNING_ACCOUNTS = {
  machinery_equipment: { expense: '8853', accumulated: '2153' },
  building:            { expense: '8852', accumulated: '2152' },
  immaterial:          { expense: '8851', accumulated: '2151' },
  group:               { expense: '8850', accumulated: '2150' },
} as const

export type OveravskrivningCategory = keyof typeof OVERAVSKRIVNING_ACCOUNTS

export interface OveravskrivningarInput {
  /** Föreslagen ökning av ackumulerade överavskrivningar. Positivt belopp
   *  ökar ackumulerade-kontot (debet 88xx), negativt minskar (kredit 88xx). */
  additionalAmount: number
  /** Account pair to use. Defaults to maskiner & inventarier (8853 / 2153),
   *  the only category where överavskrivningar is common in K2 SME. Override
   *  for buildings or immateriella tillgångar when relevant. */
  category?: OveravskrivningCategory
  /** Visa beräkningens bakgrund i UI:t. Helt fritt format. */
  computation?: Record<string, unknown>
}

/**
 * Propose an överavskrivningar entry. Caller computes the desired delta
 * using compute30Rule / compute20Rule (or enters a manual amount) and the
 * service emits the verifikation. Uses BAS 8853 / 2153 (maskiner & inventarier),
 * which covers the vast majority of cases for small AB.
 *
 * For Phase 2 this is a thin wrapper. Phase 3 (anläggningsregister) will
 * compute the delta automatically from per-asset planenlig vs skattemässig
 * schedules and pre-fill `additionalAmount`.
 */
const CATEGORY_LABELS: Record<OveravskrivningCategory, string> = {
  machinery_equipment: 'maskiner & inventarier',
  building: 'byggnader',
  immaterial: 'immateriella tillgångar',
  group: 'samlingskonto',
}

export function proposeOveravskrivningar(input: OveravskrivningarInput): ProposedDisposition | null {
  const amount = roundOre(input.additionalAmount)
  if (amount === 0) return null

  const category = input.category ?? 'machinery_equipment'
  const accounts = OVERAVSKRIVNING_ACCOUNTS[category]
  const categoryLabel = CATEGORY_LABELS[category]

  if (amount > 0) {
    return {
      kind: 'overavskrivningar',
      label: `Ökning av överavskrivningar (${categoryLabel})`,
      description: `Debet ${accounts.expense}, kredit ${accounts.accumulated}. Bokför skattemässig avskrivning utöver planenlig.`,
      amount,
      signedAmount: amount,
      lines: [
        {
          account_number: accounts.expense,
          debit_amount: amount,
          credit_amount: 0,
          line_description: 'Förändring av överavskrivningar',
        },
        {
          account_number: accounts.accumulated,
          debit_amount: 0,
          credit_amount: amount,
          line_description: 'Ackumulerade överavskrivningar',
        },
      ],
      warnings: [],
      computation: { ...input.computation, additionalAmount: amount },
    }
  }

  // Negative = upplösning av tidigare överavskrivning
  const absAmount = Math.abs(amount)
  return {
    kind: 'overavskrivningar',
    label: `Upplösning av överavskrivningar (${categoryLabel})`,
    description: `Debet ${accounts.accumulated}, kredit ${accounts.expense}. Återför tidigare gjord överavskrivning.`,
    amount: absAmount,
    signedAmount: -absAmount,
    lines: [
      {
        account_number: accounts.accumulated,
        debit_amount: absAmount,
        credit_amount: 0,
        line_description: 'Upplösning ackumulerade överavskrivningar',
      },
      {
        account_number: accounts.expense,
        debit_amount: 0,
        credit_amount: absAmount,
        line_description: 'Förändring av överavskrivningar',
      },
    ],
    warnings: ['Negativ förändring återför tidigare överavskrivning och ökar skattepliktigt resultat.'],
    computation: { ...input.computation, additionalAmount: -absAmount },
    required: true,
  }
}
