/**
 * The beloppsspärr for a dividend (ABL 17:3 first paragraph, 17:4): the
 * fritt eget kapital on the last balance sheet before the decision, less the
 * value transfers decided since that balance date (other dividends, and
 * fondemissions taken from fritt eget kapital), compared with the dividend
 * through the same function the årsredovisning's AR-DIVIDEND-EXCEEDS-EQUITY
 * check uses (lib/bokslut/arsredovisning/dividend-equity.ts).
 *
 * The fritt eget kapital is read from the statutory balance sheet mapping
 * the årsredovisning itself uses (mapTrialBalancesToK2: överkursfond,
 * balanserat resultat and årets resultat), so a dividend and the annual
 * report never disagree on the figure.
 *
 * What it cannot know it says: no earlier fiscal year in the books, or an
 * empty one, answers 'unavailable' (the caller warns, it does not block);
 * a balance sheet without a recorded årsstämma date answers adopted_on null
 * (the caller warns that the balance sheet must be adopted, 17:3).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { mapTrialBalancesToK2 } from '@/lib/bokslut/ixbrl/k2-mapper'
import { dividendExceedsFreeEquity } from '@/lib/bokslut/arsredovisning/dividend-equity'
import { roundOre, sumOre } from '@/lib/money'

export interface FreeEquityCheck {
  basis: 'balance_sheet' | 'unavailable'
  fiscal_period_id: string | null
  balance_date: string | null
  /** The årsstämma date recorded for that year's årsredovisning, if any. */
  adopted_on: string | null
  /** Fritt eget kapital on the balance sheet. */
  free_equity: number | null
  /** Dividends and fondemissions from fritt eget kapital decided after the balance date. */
  later_transfers: number
  /** What is left for this dividend. */
  available: number | null
  amount: number
  exceeds: boolean
}

interface PeriodRow {
  id: string
  period_end: string
}

/** The fiscal year whose balance sheet a decision on `decidedOn` rests on: the last one ending before it. */
async function lastBalanceSheetPeriod(supabase: SupabaseClient, companyId: string, decidedOn: string): Promise<PeriodRow | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_end')
    .eq('company_id', companyId)
    .lt('period_end', decidedOn)
    .order('period_end', { ascending: false })
    .limit(1)
  if (error) throw new Error(`fiscal_periods read failed: ${error.message}`)
  return ((data ?? []) as PeriodRow[])[0] ?? null
}

/** Fritt eget kapital on the balance sheet of a fiscal year, or null when the year holds no bookkeeping. */
export async function freeEquityOnBalanceSheet(supabase: SupabaseClient, companyId: string, fiscalPeriodId: string): Promise<number | null> {
  const [full, preClosing] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'exclude-final' }),
  ])
  if (full.rows.length === 0 && preClosing.rows.length === 0) return null
  const mapping = mapTrialBalancesToK2({ full: full.rows, preClosing: preClosing.rows }, null, { legalForm: 'aktiebolag' })
  return roundOre(mapping.totals.frittEgetKapital.current)
}

async function adoptedOn(supabase: SupabaseClient, companyId: string, fiscalPeriodId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('arsredovisning_narratives')
    .select('agm_date')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) return null
  return (data as { agm_date: string | null } | null)?.agm_date ?? null
}

/** Dividends (not cancelled, not this one) and fondemissions from fritt eget kapital decided after the balance date. */
async function laterTransfers(supabase: SupabaseClient, companyId: string, balanceDate: string, excludeDividendId: string | null): Promise<number> {
  const [dividends, changes] = await Promise.all([
    supabase.from('dividends').select('id, total_amount, status').eq('company_id', companyId).gt('decided_on', balanceDate),
    supabase
      .from('capital_changes')
      .select('id, share_capital_amount, status, source_account')
      .eq('company_id', companyId)
      .eq('kind', 'fondemission')
      .gt('decided_on', balanceDate),
  ])
  if (dividends.error) throw new Error(`dividends read failed: ${dividends.error.message}`)
  if (changes.error) throw new Error(`capital_changes read failed: ${changes.error.message}`)
  const amounts = [
    ...((dividends.data ?? []) as Array<{ id: string; total_amount: number | string; status: string }>)
      .filter((d) => d.status !== 'cancelled' && d.id !== excludeDividendId)
      .map((d) => Number(d.total_amount)),
    ...((changes.data ?? []) as Array<{ share_capital_amount: number | string; status: string; source_account: string | null }>)
      .filter((c) => c.status !== 'cancelled' && (c.source_account === '2091' || c.source_account === '2097'))
      .map((c) => Number(c.share_capital_amount)),
  ]
  return sumOre(amounts)
}

export async function checkFreeEquity(
  supabase: SupabaseClient,
  companyId: string,
  decidedOn: string,
  amount: number,
  excludeDividendId: string | null = null,
): Promise<FreeEquityCheck> {
  const period = await lastBalanceSheetPeriod(supabase, companyId, decidedOn)
  const unavailable: FreeEquityCheck = {
    basis: 'unavailable',
    fiscal_period_id: period?.id ?? null,
    balance_date: period?.period_end ?? null,
    adopted_on: null,
    free_equity: null,
    later_transfers: 0,
    available: null,
    amount: roundOre(amount),
    exceeds: false,
  }
  if (!period) return unavailable
  const [free, adopted, later] = await Promise.all([
    freeEquityOnBalanceSheet(supabase, companyId, period.id),
    adoptedOn(supabase, companyId, period.id),
    laterTransfers(supabase, companyId, period.period_end, excludeDividendId),
  ])
  if (free === null) return { ...unavailable, adopted_on: adopted }
  const available = roundOre(free - later)
  return {
    basis: 'balance_sheet',
    fiscal_period_id: period.id,
    balance_date: period.period_end,
    adopted_on: adopted,
    free_equity: free,
    later_transfers: later,
    available,
    amount: roundOre(amount),
    exceeds: dividendExceedsFreeEquity(amount, available),
  }
}
