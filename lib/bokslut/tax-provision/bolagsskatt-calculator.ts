import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
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
  /** Taxable result before tax, floored to a whole 10 SEK and clamped at zero. */
  taxableResultClamped: number
  taxRate: number
  taxAmount: number
}

export interface PostedDispositionsEffect {
  /** Signed P&L effect of every effective posted year-end P&L booking (class
   *  88 + 7533 + 78xx planenlig avskrivning): a cost lowers it, a återföring
   *  raises it. */
  total: number
  /** The 7533 (särskild löneskatt) portion of `total`. Callers use it to
   *  detect an already-posted SLP so it is neither re-proposed nor
   *  double-counted on a resumed bokslut run. Negative when SLP is posted. */
  slpPortion: number
  /** Tax provision booked by the year-end flow. This is excluded from
   *  `total`, but lets callers distinguish it from manually posted 8910. */
  taxProvisionPortion: number
}

/**
 * Sum the P&L effect of bokslut-flow postings already made in this period.
 *
 * Dispositioner (periodiseringsfond avsättning/återföring, SLP, över-
 * avskrivningar) AND planenlig avskrivning are booked with
 * source_type='year_end', which generateIncomeStatement EXCLUDES: so
 * net_result alone overstates resultat före skatt. The tax base must add them
 * back. We sum class 88 (bokslutsdispositioner), 7533 (SLP) and class 78
 * (planenlig avskrivning, posted by lib/bokslut/assets/depreciation-engine.ts);
 * tax (89xx) is intentionally left out because the base is resultat FÖRE
 * skatt, and the final closing entry is excluded outright (see below).
 *
 * 78xx is included since #1051: without it the bolagsskatt base and the
 * periodiseringsfond 25 % cap are computed on a resultat före skatt that
 * silently omits every depreciation krona booked from the bokslut flow.
 * Only the 78xx cost leg moves the base; its 12xx ack.-avskrivning
 * counter-leg is a balance-sheet account and is ignored here.
 *
 * The period's final bokslutsverifikation (fiscal_periods.closing_entry_id)
 * is excluded from the fetch. It also carries source_type='year_end' and it
 * reverses every P&L account, 78xx / 88xx / 7533 included, so counting it
 * would cancel the very add-back this function exists to produce once the
 * year is closed.
 *
 * A corrected year_end entry is counted through its replacement: the
 * original is status='reversed' (skipped here) and the income statement
 * excludes both it and its storno/correction chain, so the posted
 * correction entry (source_type='correction', correction_of_id → the
 * original) is the effective disposition and must be summed. Depth-1 chains
 * only: corrections of corrections of year_end entries are not followed.
 *
 * Used by the commit path, where bolagsskatt is computed AFTER the other
 * dispositions are posted, and by the preview builder for resumed runs.
 */
export async function sumPostedYearEndDispositions(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<PostedDispositionsEffect> {
  type Row = {
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }
  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts).
  let data: Row[]
  try {
    // The final bokslutsverifikation is source_type='year_end' too and
    // reverses every P&L account. Excluding it keeps the add-back intact
    // after the year is closed (see docstring).
    //
    // company_id is filtered even though id is the primary key: every sibling
    // query in this function carries the tenant scope, and service-role paths
    // have no RLS to fall back on. A read failure must NOT fall through to
    // closingEntryId = null either: that silently re-admits the closing
    // entry's 78xx/88xx reversals and understates the tax base, which is the
    // exact failure this fetch exists to prevent. Fail loudly instead; the
    // surrounding catch turns it into 'Failed to read posted dispositions'.
    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (periodError) throw periodError
    const closingEntryId = (period as { closing_entry_id?: string | null } | null)
      ?.closing_entry_id ?? null

    data = await fetchEntryLines<Row>({
      supabase,
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) => {
        const base = q
          .eq('company_id', companyId)
          .eq('fiscal_period_id', fiscalPeriodId)
          .eq('status', 'posted')
          .eq('source_type', 'year_end')
        return closingEntryId ? base.neq('id', closingEntryId) : base
      },
      attachEntriesAs: null,
    })

    // Replacements of corrected year_end entries (see docstring). Only
    // reversed originals can be correction targets, so the id list is empty
    // in the common case and the extra fetch is skipped. Targets are looked
    // up COMPANY-WIDE (a current-period correction can point at a
    // prior-period year_end entry when that period is locked) while the
    // correction entries themselves stay scoped to this period, matching the
    // trial balance's company-wide chain exclusion.
    const reversedYearEndIds = (
      await fetchAllRows<{ id: string }>(({ from, to }) =>
        supabase
          .from('journal_entries')
          .select('id')
          .eq('company_id', companyId)
          .eq('source_type', 'year_end')
          .eq('status', 'reversed')
          .order('id', { ascending: true })
          .range(from, to)
      )
    ).map((r) => r.id)

    if (reversedYearEndIds.length > 0) {
      const corrections = await fetchEntryLines<Row>({
        supabase,
        lineColumns: 'account_number, debit_amount, credit_amount',
        filterEntries: (q: EntryLinesQuery) =>
          q
            .eq('company_id', companyId)
            .eq('fiscal_period_id', fiscalPeriodId)
            .eq('status', 'posted')
            .eq('source_type', 'correction')
            .in('correction_of_id', reversedYearEndIds),
        attachEntriesAs: null,
      })
      data = data.concat(corrections)
    }
  } catch (err) {
    throw new Error(
      `Failed to read posted dispositions: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let effect = 0
  let slp = 0
  let taxProvision = 0
  for (const row of data) {
    const acc = row.account_number
    const delta = (Number(row.credit_amount) || 0) - (Number(row.debit_amount) || 0)
    // Deliberately NOT a class 3-8 sweep: a correction entry pulled in below
    // can carry any account, and only these three groups are bokslut-flow
    // P&L postings the income statement dropped.
    if (acc.startsWith('88') || acc.startsWith('78') || acc === '7533') {
      effect += delta
      if (acc === '7533') slp += delta
    }
    if (acc === '8910') taxProvision += -delta
  }
  return {
    total: roundOre(effect),
    slpPortion: roundOre(slp),
    taxProvisionPortion: roundOre(taxProvision),
  }
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
    // path byte-identical: DECISIONS.md:632 records that this call chain
    // already caused a too-high-tax customer bug once.
    closingEntry: 'include',
  })
  const amount = trialBalance.rows
    .filter((row) => row.account_number === '8910')
    .reduce((sum, row) => sum + row.closing_debit - row.closing_credit, 0)
  return roundOre(Math.max(0, amount))
}

/**
 * Compute bolagsskatt 20.6 % on the company's taxable result.
 *
 * Reads income-statement result before tax and adds the manual adjustments
 * the user provided (non-deductible expenses, schablonintäkt, etc.). The
 * resulting taxable result is rounded down to the nearest whole 10 SEK before
 * applying the tax rate, per IL 1 kap 7 §.
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

  // Round down to a whole 10 SEK before applying the rate. Negative taxable
  // result means no tax provision (handled as inrullat underskott in INK2).
  const taxableResultClamped = Math.floor(Math.max(0, taxableResult) / 10) * 10
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
