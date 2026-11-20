import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { proposeForTransactions } from '@/lib/transactions/propose'
import { findSalaryRunPayouts, type SalaryRunPayout } from '@/lib/transactions/salary-run-payouts'
import type { Transaction } from '@/types'

/**
 * POST /api/transactions/suggest-categories
 * The booking proposals for a batch of transactions (lib/transactions/propose.ts),
 * keyed by transaction id, plus the assistant's fresh stored reads and the
 * company's one-click switch the page decides a row's Bokför with
 * (reviewRequired, lib/transactions/direct-booking.ts). Batch size limited to 50.
 *
 * `salary_payouts` names the rows a booked salary run already pays out, with
 * the run's verifikat (lib/transactions/salary-run-payouts.ts, the matcher
 * the MCP suggest_categories tool offers its link from): the row is matched
 * to that verifikat, never booked again (crm#1685). Only rows with a cash
 * account, since the match names the bank account. Best effort: the
 * proposals never wait on it.
 */
export const POST = withRouteContext(
  'transaction.suggest_categories',
  async (request, { supabase, companyId, log }) => {
    const { transaction_ids } = await request.json()

    if (!Array.isArray(transaction_ids) || transaction_ids.length === 0) {
      return NextResponse.json({ error: 'transaction_ids is required' }, { status: 400 })
    }

    const ids = transaction_ids.slice(0, 50)

    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .in('id', ids)

    if (txError || !transactions) {
      return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 })
    }

    const rows = transactions as Transaction[]
    const [{ proposals, assistant_reads, direct_booking }, payouts] = await Promise.all([
      proposeForTransactions(supabase, companyId, rows),
      findSalaryRunPayouts(supabase, companyId, rows).catch((err: unknown) => {
        log.warn('salary run payouts read failed; the proposals stand', {
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }),
    ])
    const salary_payouts: Record<string, SalaryRunPayout> = {}
    for (const tx of rows) {
      const payout = payouts?.links.get(tx.id)
      if (payout && tx.cash_account_id) salary_payouts[tx.id] = payout
    }
    return NextResponse.json({ template_suggestions: proposals, assistant_reads, direct_booking, salary_payouts })
  },
)
