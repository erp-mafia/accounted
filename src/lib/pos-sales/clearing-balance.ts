import type { PosTender } from '@accounted/connect-contract'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolvePosSalesSettings } from './settings'
import { toNumber } from './types'

/**
 * The till's card and Swish money not yet in the bank, for a monthly check
 * in one look: the ledger balance of the accounts card and Swish clear on
 * (1686 by default), and beside it the card and Swish of the days not booked
 * yet, which the ledger cannot see. Once every day is booked and every
 * payout booked against the account, what is left on it is what is still on
 * its way; a large or a negative figure is a payout booked as sales, or a
 * day booked twice.
 *
 * The balance is read the way the balance sheet reads it (the trial balance,
 * ingående balans included) as of a date, in the fiscal year covering it.
 */

export interface PosClearingBalance {
  as_of: string
  /** The accounts card and Swish book to, over every connection; cash ledgers are not clearing accounts. */
  accounts: string[]
  /** Debit minus credit on those accounts as of as_of; null when no fiscal year covers as_of. */
  ledger_balance: number | null
  fiscal_period_id: string | null
  /** Days up to as_of not booked yet that took card or Swish. */
  unbooked_days: number
  /** Their card and Swish, tips included: not in ledger_balance until the days are booked. */
  unbooked_amount: number
}

const CLEARING_KINDS = ['card', 'swish'] as const

export async function getPosClearingBalance(
  ctx: OperationContext,
  input: { as_of?: string } = {},
): Promise<OperationOutcome<PosClearingBalance>> {
  const asOf = input.as_of ?? todayIsoStockholm()
  const { data: connections, error } = await ctx.supabase
    .from('pos_connections')
    .select('id, settings')
    .eq('company_id', ctx.companyId)
  if (error) {
    ctx.log.error('pos connections read failed', error)
    return { ok: false, code: 'POS_READ_FAILED' }
  }
  const rows = (connections ?? []) as Array<{ id: string; settings: unknown }>
  if (rows.length === 0) return { ok: false, code: 'POS_CONNECTION_NOT_FOUND', details: { connection_id: null } }

  // Per connection, the kinds that book to a clearing account, and the accounts.
  const kindsByConnection = new Map<string, Set<string>>()
  const accounts = new Set<string>()
  for (const row of rows) {
    const settings = resolvePosSalesSettings(row.settings)
    const kinds = new Set<string>()
    for (const kind of CLEARING_KINDS) {
      const account = settings.tender_accounts[kind]
      if (!account || isCashLedger(account)) continue
      kinds.add(kind)
      accounts.add(account)
    }
    kindsByConnection.set(row.id, kinds)
  }

  let unbookedDays: Array<{ connection_id: string; tenders: unknown }>
  let period: { id: string } | null
  try {
    const [days, periodResult] = await Promise.all([
      fetchAllRows<{ id: string; connection_id: string; tenders: unknown }>(({ from, to }) =>
        ctx.supabase
          .from('pos_sales_days')
          .select('id, connection_id, tenders')
          .eq('company_id', ctx.companyId)
          .is('journal_entry_id', null)
          .in('status', ['ready', 'needs_review'])
          .lte('business_date', asOf)
          .order('id', { ascending: true })
          .range(from, to),
      ),
      ctx.supabase
        .from('fiscal_periods')
        .select('id')
        .eq('company_id', ctx.companyId)
        .lte('period_start', asOf)
        .gte('period_end', asOf)
        .order('period_start', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    if (periodResult.error) throw new Error(periodResult.error.message)
    unbookedDays = days
    period = (periodResult.data as { id: string } | null) ?? null
  } catch (err) {
    ctx.log.error('pos clearing balance read failed', err as Error)
    return { ok: false, code: 'POS_READ_FAILED' }
  }

  let unbookedCount = 0
  let unbookedAmount = 0
  for (const day of unbookedDays) {
    const kinds = kindsByConnection.get(day.connection_id)
    if (!kinds || kinds.size === 0) continue
    const tenders = (Array.isArray(day.tenders) ? day.tenders : []) as PosTender[]
    const amount = tenders.filter((t) => kinds.has(t.kind)).reduce((sum, t) => sum + toNumber(t.amount), 0)
    if (amount === 0) continue
    unbookedCount += 1
    unbookedAmount += amount
  }

  const accountList = [...accounts].sort()
  // Nothing clears anywhere when every kind books straight to a cash ledger.
  let ledgerBalance: number | null = accountList.length === 0 ? 0 : null
  if (period && accountList.length > 0) {
    try {
      const { rows: balances } = await generateTrialBalance(ctx.supabase, ctx.companyId, period.id, {
        closingEntry: 'include',
        toDate: asOf,
        // The chart only labels the rows; the amounts never depend on it.
        chart: [],
      })
      let sum = 0
      for (const row of balances) if (accounts.has(row.account_number)) sum += row.closing_debit - row.closing_credit
      ledgerBalance = roundOre(sum)
    } catch (err) {
      ctx.log.error('pos clearing balance trial balance failed', err as Error, { fiscalPeriodId: period.id })
      return { ok: false, code: 'POS_READ_FAILED' }
    }
  }

  return {
    ok: true,
    data: {
      as_of: asOf,
      accounts: accountList,
      ledger_balance: ledgerBalance,
      fiscal_period_id: period?.id ?? null,
      unbooked_days: unbookedCount,
      unbooked_amount: roundOre(unbookedAmount),
    },
  }
}
