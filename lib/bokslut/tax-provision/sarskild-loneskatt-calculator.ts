import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { SLP_RATE } from '@/lib/bookkeeping/slp-lines'
import { roundOre } from '@/lib/money'
import type { ProposedDisposition } from '../types'

// Single source for the 24.26 % rate: lib/bookkeeping/slp-lines.ts (shared
// with the supplier-invoice booking engine's per-line SLP pair). Re-exported
// so existing imports from this module keep working.
export { SLP_RATE }

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
  /** SLP already posted to 7533 during the period (net of credits), e.g. by
   *  supplier-invoice lines flagged apply_slp. Subtracted from the proposal
   *  so bokslut never provisions the same premiums twice. */
  slpAlreadyPosted: number
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
  type Row = {
    account_number: string | null
    debit_amount: number | string | null
    credit_amount: number | string | null
  }
  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts). One
  // query covers both the SLP base (7410-7419) and the SLP already posted to
  // 7533 during the year (supplier-invoice lines flagged apply_slp book the
  // 7533/2514 pair at registration); the rows are partitioned below.
  const PENSION_ACCOUNTS = Array.from({ length: 10 }, (_, i) => `741${i}`)
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
        q.in('account_number', [...PENSION_ACCOUNTS, '7533']),
      attachEntriesAs: null,
    })
  } catch (err) {
    throw new Error(
      `Failed to fetch pension costs: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Net = debit − credit (cost accounts have normal debit balance).
  const netDebit = (rows: Row[]) =>
    rows.reduce(
      (sum, row) => sum + ((Number(row.debit_amount) || 0) - (Number(row.credit_amount) || 0)),
      0,
    )
  const pensionCostsBooked = netDebit(
    data.filter((row) => row.account_number != null && row.account_number !== '7533'),
  )
  // Double-count guard: premiums flagged apply_slp on supplier invoices have
  // already booked their 7533/2514 pair during the year. Those debits sit on
  // 7533 in this same fiscal period, so subtracting them leaves exactly the
  // unprovisioned remainder. Floored at zero: an over-provisioned year never
  // proposes a negative disposition.
  const slpAlreadyPosted = netDebit(data.filter((row) => row.account_number === '7533'))

  const manualAdjustment = options.manualAdjustment ?? 0
  const base = Math.max(0, pensionCostsBooked + manualAdjustment)
  const slpAmount = Math.max(0, Math.round(base * SLP_RATE - slpAlreadyPosted))

  const computation: SlpComputation = {
    pensionCostsBooked: Math.round(pensionCostsBooked * 100) / 100,
    manualAdjustment,
    base,
    rate: SLP_RATE,
    slpAlreadyPosted: roundOre(slpAlreadyPosted),
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
        line_description:
          slpAlreadyPosted > 0
            ? `SLP 24,26 % på ${base} kr pensionskostnader, minus ${computation.slpAlreadyPosted} kr redan bokförd SLP`
            : `SLP 24,26 % på ${base} kr pensionskostnader`,
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
