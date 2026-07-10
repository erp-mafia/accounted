import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import type { ProposedDisposition } from '../types'

/** Särskild löneskatt på pensionskostnader (SLP). 24.26 % per SLF 1991:687. */
export const SLP_RATE = 0.2426

export interface SlpComputation {
  /** Total pension cost during the period: sum of posted debits on accounts
   *  7410-7419 (pensionsförsäkringspremier, individuella pensioner, etc.). */
  pensionCostsBooked: number
  /** Optional manual adjustment: e.g. avsättning till pensionsskuld on 2210
   *  bokad under perioden som inte ligger på 7410-7419 men ska SLP-belastas. */
  manualAdjustment: number
  /** Base for SLP = pensionCostsBooked + manualAdjustment. */
  base: number
  rate: number
  slpAmount: number
}

/**
 * Compute särskild löneskatt på pensionskostnader.
 *
 * SLP gäller arbetsgivares kostnader för avtalspension samt pensionsavsättningar
 * (men inte allmän pension som finansieras av arbetsgivaravgifterna). Räknas
 * på 7410-7419 (tjänstepensionspremier) och avsättningar till pensionsskuld.
 *
 * Caller can supply `manualAdjustment` to include pensionsavsättningar made on
 * 2210 (avsättning för pensioner) that aren't reflected in 7410-7419: common
 * when companies book direct to the avsättningskonto rather than via a cost
 * account.
 */
export async function calculateSarskildLoneskatt(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { manualAdjustment?: number } = {},
): Promise<ProposedDisposition | null> {
  type Row = { debit_amount: number | string | null; credit_amount: number | string | null }
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
          .eq('status', 'posted'),
      filterLines: (q: EntryLinesQuery) =>
        q.gte('account_number', '7410').lte('account_number', '7419'),
      attachEntriesAs: null,
    })
  } catch (err) {
    throw new Error(
      `Failed to fetch pension costs: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const pensionCostsBooked = data.reduce((sum, row) => {
    // Cost account: normal balance is debit, so net = debit − credit.
    return sum + ((Number(row.debit_amount) || 0) - (Number(row.credit_amount) || 0))
  }, 0)

  const manualAdjustment = options.manualAdjustment ?? 0
  const base = Math.max(0, pensionCostsBooked + manualAdjustment)
  const slpAmount = Math.round(base * SLP_RATE)

  const computation: SlpComputation = {
    pensionCostsBooked: Math.round(pensionCostsBooked * 100) / 100,
    manualAdjustment,
    base,
    rate: SLP_RATE,
    slpAmount,
  }

  if (slpAmount === 0) {
    return null
  }

  return {
    kind: 'sarskild_loneskatt',
    label: 'Särskild löneskatt på pensionskostnader (24,26 %)',
    description: 'Debet 7533, kredit 2514.',
    amount: slpAmount,
    lines: [
      {
        account_number: '7533',
        debit_amount: slpAmount,
        credit_amount: 0,
        line_description: `SLP 24,26 % på ${base} kr pensionskostnader`,
      },
      {
        account_number: '2514',
        debit_amount: 0,
        credit_amount: slpAmount,
        line_description: 'Beräknad särskild löneskatt på pensionskostnader',
      },
    ],
    warnings: [],
    computation: computation as unknown as Record<string, unknown>,
  }
}
