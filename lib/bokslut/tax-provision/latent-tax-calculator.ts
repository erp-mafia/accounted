import type { CreateJournalEntryLineInput } from '@/types'

/**
 * Statutory split of obeskattade reserver (21xx — periodiseringsfonder,
 * överavskrivningar, etc.) under K3 (BFNAR 2012:1).
 *
 * The full balance is taxable when the reserve is reversed, so K3 requires
 * the balance to be presented as:
 *   - 79.4 % equity (bundet eget kapital — the post-tax economic value)
 *   - 20.6 % deferred tax liability (uppskjuten skatteskuld, account 2240)
 *
 * 20.6 % is the current Swedish bolagsskatt rate (since 2021). If the rate
 * changes (it has been 20.6 % since fiscal year 2021), pass an override.
 *
 * Under K2 this split does NOT apply — the obeskattade reserver row stays
 * intact between eget kapital and skulder and 2240 is excluded from the chart.
 */
export const LATENT_TAX_DEFAULT_RATE = 0.206

/** BAS account for the K3 latent tax liability. */
export const LATENT_TAX_LIABILITY_ACCOUNT = '2240'

/** BAS account for the K3 latent tax expense (income statement). */
export const LATENT_TAX_EXPENSE_ACCOUNT = '8940'

export interface LatentTaxSplit {
  /** The 79.4 % portion that K3 folds into equity for soliditet / BR purposes. */
  equityPortion: number
  /** The 20.6 % portion presented as a separate deferred tax liability (2240). */
  liabilityPortion: number
}

/**
 * Compute the K3 equity / liability split of a given untaxed-reserves total.
 *
 * Pure function — no DB access. Caller passes the *current* sum of 21xx
 * (post all dispositioner the user has accepted in the bokslut flow).
 *
 * Monetary precision: rounds to öre (2 decimals) via Math.round(x*100)/100
 * per project convention. liabilityPortion is computed first so the split
 * always reconciles (equityPortion = total − liability rounded the same way).
 *
 * Negative reserves are unusual (would indicate over-reversal) but the math
 * is symmetric — both portions come out negative, preserving the sign.
 */
export function computeLatentTax(params: {
  untaxedReserves: number
  taxRate?: number
}): LatentTaxSplit {
  const taxRate = params.taxRate ?? LATENT_TAX_DEFAULT_RATE
  const liabilityPortion = Math.round(params.untaxedReserves * taxRate * 100) / 100
  const equityPortion = Math.round((params.untaxedReserves - liabilityPortion) * 100) / 100
  return { equityPortion, liabilityPortion }
}

/**
 * Tolerance for "no change" detection. The latent tax provision posts in
 * whole krona via the engine, so an absolute delta below 1 öre means the
 * stored 2240 balance already matches the target and no adjustment is needed.
 */
const LATENT_TAX_ORE_TOLERANCE = 0.01

/**
 * Generate the journal lines needed to move the 2240 balance from its
 * current amount to the new target. Returns null when no adjustment is
 * required (delta below 1 öre — see {@link LATENT_TAX_ORE_TOLERANCE}).
 *
 * Direction:
 *   - target > current → latent tax LIABILITY grew → debit 8940 (cost),
 *     credit 2240 (liability).
 *   - target < current → latent tax LIABILITY shrank → debit 2240, credit
 *     8940 (income — a reversal of prior expense).
 *
 * The entry posts as `source_type='year_end'` and is meant to be created via
 * `createJournalEntry()` so the engine assigns the voucher number atomically
 * and enforces the balance/period rules.
 */
export function proposeLatentTaxChange(
  currentLatentTax2240: number,
  targetLatentTax2240: number,
): CreateJournalEntryLineInput[] | null {
  const delta = Math.round((targetLatentTax2240 - currentLatentTax2240) * 100) / 100
  if (Math.abs(delta) < LATENT_TAX_ORE_TOLERANCE) return null

  const absoluteDelta = Math.abs(delta)
  if (delta > 0) {
    // Liability increased — debit 8940 (expense), credit 2240 (liability).
    return [
      {
        account_number: LATENT_TAX_EXPENSE_ACCOUNT,
        debit_amount: absoluteDelta,
        credit_amount: 0,
        line_description: 'Förändring uppskjuten skatt (K3)',
      },
      {
        account_number: LATENT_TAX_LIABILITY_ACCOUNT,
        debit_amount: 0,
        credit_amount: absoluteDelta,
        line_description: 'Avsättning uppskjuten skatteskuld',
      },
    ]
  }
  // Liability decreased — debit 2240, credit 8940.
  return [
    {
      account_number: LATENT_TAX_LIABILITY_ACCOUNT,
      debit_amount: absoluteDelta,
      credit_amount: 0,
      line_description: 'Återföring uppskjuten skatteskuld',
    },
    {
      account_number: LATENT_TAX_EXPENSE_ACCOUNT,
      debit_amount: 0,
      credit_amount: absoluteDelta,
      line_description: 'Förändring uppskjuten skatt (K3)',
    },
  ]
}
