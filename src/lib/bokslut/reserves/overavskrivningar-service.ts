import type { ProposedDisposition } from '../types'
import { roundOre } from '@/lib/money'

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
