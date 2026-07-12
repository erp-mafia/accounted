import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import type { ProposedDisposition } from '../types'

/** Bolagsskatt rate. 20.6 % since 2021 (gäller räkenskapsår påbörjat efter 31 dec 2020). */
export const BOLAGSSKATT_RATE = 0.206

export interface BolagsskattInput {
  /** Result before tax to use as the base, OVERRIDING the income-statement
   *  net_result. The dispositions builder passes this in *preview* mode: there,
   *  the proposed bokslutsdispositioner (periodiseringsfond avsättning/
   *  återföring, SLP) are not posted yet, so the income statement still shows
   *  the *pre-disposition* result. The builder computes the post-disposition
   *  result itself and passes it here so the previewed tax matches what the
   *  sequential commit will actually book. When omitted, the calculator reads
   *  incomeStatement.net_result: correct only once the dispositions are already
   *  posted (the POST commit path, where bolagsskatt is computed last). */
  resultBeforeTaxOverride?: number
  /** Manual adjustments to taxable result that the calculator can't derive.
   *  Each is a SEK amount that ADDS to taxable result (so e.g. non-deductible
   *  representation costs are positive; non-taxable dividend income is negative). */
  manualAdjustments?: {
    /** e.g. ej avdragsgilla kostnader: representation > schablon, böter, gåvor. */
    nonDeductibleExpenses?: number
    /** e.g. skattefria intäkter: näringsbetingad utdelning. */
    nonTaxableIncome?: number
    /** Schablonintäkt on periodiseringsfond opening balance (statslåneräntan
     *  × ingående saldo). Computed by periodiseringsfond-service so callers
     *  can pass it through. */
    schablonintaktPeriodiseringsfond?: number
    /** Other adjustments: free-form. */
    other?: number
  }
}

export interface BolagsskattComputation {
  /** Net result from the income statement (already includes any class 88xx
   *  bokslutsdispositioner that the user posted before reaching this step). */
  resultBeforeTax: number
  nonDeductibleExpenses: number
  nonTaxableIncome: number
  schablonintaktPeriodiseringsfond: number
  otherAdjustments: number
  taxableResult: number
  /** Taxable result before tax: equals max(taxableResult, 0). */
  taxableResultClamped: number
  taxRate: number
  taxAmount: number
}

/**
 * Sum the P&L effect of bokslutsdispositioner already posted in this period.
 *
 * Dispositioner (periodiseringsfond avsättning/återföring, SLP, över-
 * avskrivningar) are booked with source_type='year_end', which
 * generateIncomeStatement EXCLUDES: so net_result alone overstates resultat
 * före skatt. The tax base must add them back. We sum class 88
 * (bokslutsdispositioner) plus 7533 (SLP); tax (89xx) and the closing entry
 * (8999/2099) are intentionally left out.
 *
 * Returns a signed SEK amount: avsättning (8811 debit) lowers it, återföring
 * (8819 credit) raises it. Used by the commit path, where bolagsskatt is
 * computed AFTER the other dispositions are posted.
 */
export async function sumPostedYearEndDispositions(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<number> {
  type Row = {
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }
  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts).
  let data: Row[]
  try {
    data = await fetchEntryLines<Row>({
      supabase,
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', companyId)
          .eq('fiscal_period_id', fiscalPeriodId)
          .eq('status', 'posted')
          .eq('source_type', 'year_end'),
      attachEntriesAs: null,
    })
  } catch (err) {
    throw new Error(
      `Failed to read posted dispositions: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let effect = 0
  for (const row of data) {
    const acc = row.account_number
    if (!(acc.startsWith('88') || acc === '7533')) continue
    effect += (Number(row.credit_amount) || 0) - (Number(row.debit_amount) || 0)
  }
  return Math.round(effect * 100) / 100
}

/**
 * Compute bolagsskatt 20.6 % on the company's taxable result.
 *
 * Reads income-statement result before tax and adds the manual adjustments
 * the user provided (non-deductible expenses, schablonintäkt, etc.). The
 * resulting taxable result is rounded down to nearest whole krona before
 * applying the tax rate, per SFL 22 kap 1 §.
 *
 * If the period shows a loss, no tax is proposed: Swedish AB accumulate
 * inrullat underskott for future offset, but that bookkeeping is handled
 * separately in NE/INK2 rather than as a current-year provision.
 */
export async function calculateBolagsskatt(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  input: BolagsskattInput = {},
): Promise<ProposedDisposition | null> {
  // Prefer an explicit base when the caller already knows the post-disposition
  // result (preview mode). Only hit the income statement when no override is
  // given: that path is correct once the dispositions are posted (commit).
  const resultBeforeTax =
    input.resultBeforeTaxOverride ??
    (await generateIncomeStatement(supabase, companyId, fiscalPeriodId)).net_result

  const adjustments = input.manualAdjustments ?? {}
  const nonDeductibleExpenses = adjustments.nonDeductibleExpenses ?? 0
  const nonTaxableIncome = adjustments.nonTaxableIncome ?? 0
  const schablonintaktPeriodiseringsfond = adjustments.schablonintaktPeriodiseringsfond ?? 0
  const otherAdjustments = adjustments.other ?? 0

  const taxableResult =
    resultBeforeTax +
    nonDeductibleExpenses -
    nonTaxableIncome +
    schablonintaktPeriodiseringsfond +
    otherAdjustments

  // Truncate to whole krona before applying rate. Negative taxable result =
  // no tax provision (handled as inrullat underskott in INK2, not here).
  const taxableResultClamped = Math.max(0, Math.floor(taxableResult))
  const taxAmount = Math.round(taxableResultClamped * BOLAGSSKATT_RATE)

  const computation: BolagsskattComputation = {
    resultBeforeTax,
    nonDeductibleExpenses,
    nonTaxableIncome,
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
