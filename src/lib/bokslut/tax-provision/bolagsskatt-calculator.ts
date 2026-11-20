import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type { ProposedDisposition } from '../types'

/** Bolagsskatt rate. 20.6 % since 2021 (gäller räkenskapsår påbörjat efter 31 dec 2020). */
export const BOLAGSSKATT_RATE = 0.206

export interface BolagsskattInput {
  /** Resultat före skatt after every disposition: the ledger's (readYearResult)
   *  plus those proposed but not posted yet, so a previewed tax matches what
   *  the sequential commit books. */
  resultBeforeTax: number
  /** Manual adjustments to taxable result that the calculator can't derive.
   *  Each is a SEK amount that ADDS to taxable result (so e.g. non-deductible
   *  representation costs are positive; non-taxable dividend income is negative). */
  manualAdjustments?: {
    /** e.g. ej avdragsgilla kostnader: representation > schablon, böter, gåvor. */
    nonDeductibleExpenses?: number
    /** e.g. skattefria intäkter: näringsbetingad utdelning. */
    nonTaxableIncome?: number
    /** Outnyttjat underskott från föregående beskattningsår (INK2S 4.14 a):
     *  deducted when the year's överskott is computed, IL 40 kap. 2 §. */
    deficitCarryforward?: number
    /** Schablonintäkt on periodiseringsfond opening balance (statslåneräntan
     *  × ingående saldo). Computed by periodiseringsfond-service so callers
     *  can pass it through. */
    schablonintaktPeriodiseringsfond?: number
    /** Other adjustments: free-form. */
    other?: number
  }
}

export interface BolagsskattComputation {
  resultBeforeTax: number
  nonDeductibleExpenses: number
  nonTaxableIncome: number
  deficitCarryforward: number
  schablonintaktPeriodiseringsfond: number
  otherAdjustments: number
  taxableResult: number
  /** Taxable result before tax, floored to a whole 10 SEK and clamped at zero. */
  taxableResultClamped: number
  taxRate: number
  taxAmount: number
}

/**
 * Return the effective tax expense on 8910 for an open fiscal period.
 * Trial balance already nets storno and correction entries, which makes this
 * suitable as the idempotency check before a new tax voucher is posted.
 */
export async function getBookedBolagsskatt(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<number> {
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    // The contract above is an OPEN period, where no closing entry exists, so
    // 'include' and 'exclude-final' agree. Left as 'include' to keep the tax
    // path byte-identical: DECISIONS.md archive 2026-07-29 records that this call chain
    // already caused a too-high-tax customer bug once.
    closingEntry: 'include',
  })
  const amount = trialBalance.rows
    .filter((row) => row.account_number === '8910')
    .reduce((sum, row) => sum + row.closing_debit - row.closing_credit, 0)
  return roundOre(Math.max(0, amount))
}

/**
 * Compute bolagsskatt 20.6 % on the company's taxable result: resultat före
 * skatt plus the manual adjustments the user provided (non-deductible
 * expenses, schablonintäkt, etc.). The resulting taxable result is rounded
 * down to the nearest whole 10 SEK before applying the tax rate, per IL 1 kap
 * 7 §.
 *
 * If the period shows a loss, no tax is proposed: Swedish AB accumulate
 * inrullat underskott for future offset, but that bookkeeping is handled
 * separately in NE/INK2 rather than as a current-year provision.
 */
export function calculateBolagsskatt(input: BolagsskattInput): ProposedDisposition {
  const { resultBeforeTax } = input
  const adjustments = input.manualAdjustments ?? {}
  const nonDeductibleExpenses = adjustments.nonDeductibleExpenses ?? 0
  const nonTaxableIncome = adjustments.nonTaxableIncome ?? 0
  const deficitCarryforward = adjustments.deficitCarryforward ?? 0
  const schablonintaktPeriodiseringsfond = adjustments.schablonintaktPeriodiseringsfond ?? 0
  const otherAdjustments = adjustments.other ?? 0

  // roundOre the sum before it is floored below: five independently sourced
  // doubles can land just under a whole ten (715.21 + 19196.29 + 1515.44 +
  // 19658.68 + 15024.38 is 56109.99999999999), and the floor to tens then
  // takes the base 10 kr low instead of 1 (#2597). It also keeps the value
  // stored on the computation record, which the UI shows, free of drift.
  const taxableResult = roundOre(
    resultBeforeTax +
    nonDeductibleExpenses -
    nonTaxableIncome -
    deficitCarryforward +
    schablonintaktPeriodiseringsfond +
    otherAdjustments,
  )

  // Round down to a whole 10 SEK before applying the rate. Negative taxable
  // result means no tax provision (handled as inrullat underskott in INK2).
  const taxableResultClamped = Math.floor(Math.max(0, taxableResult) / 10) * 10
  const taxAmount = Math.round(taxableResultClamped * BOLAGSSKATT_RATE)

  const computation: BolagsskattComputation = {
    resultBeforeTax,
    nonDeductibleExpenses,
    nonTaxableIncome,
    deficitCarryforward,
    schablonintaktPeriodiseringsfond,
    otherAdjustments,
    taxableResult,
    taxableResultClamped,
    taxRate: BOLAGSSKATT_RATE,
    taxAmount,
  }

  if (taxAmount === 0) {
    // No tax proposal for loss-year, but expose computation so the UI can show
    // why nothing was booked.
    return {
      kind: 'bolagsskatt',
      label: 'Bolagsskatt 20,6 %',
      description:
        taxableResult <= 0
          ? 'Ingen skatt: året visar förlust eller noll resultat. Underskottet rullas in i nästa år (hanteras i INK2).'
          : 'Skattemässigt resultat blev noll efter justeringar. Ingen skatt att boka.',
      amount: 0,
      lines: [],
      warnings: [],
      computation: computation as unknown as Record<string, unknown>,
    }
  }

  return {
    kind: 'bolagsskatt',
    label: 'Bolagsskatt 20,6 %',
    description: `Skatt på årets skattemässiga resultat. Debet 8910, kredit 2512.`,
    amount: taxAmount,
    lines: [
      {
        account_number: '8910',
        debit_amount: taxAmount,
        credit_amount: 0,
        line_description: `Bolagsskatt 20,6 % på ${taxableResultClamped} kr`,
      },
      {
        account_number: '2512',
        debit_amount: 0,
        credit_amount: taxAmount,
        line_description: 'Beräknad inkomstskatt',
      },
    ],
    warnings: [],
    computation: computation as unknown as Record<string, unknown>,
  }
}
