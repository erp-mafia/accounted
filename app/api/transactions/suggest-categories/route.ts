import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { proposeForTransactions } from '@/lib/transactions/propose'
import type { Transaction } from '@/types'

/**
 * POST /api/transactions/suggest-categories
 * The booking proposals for a batch of transactions (lib/transactions/propose.ts),
 * keyed by transaction id, plus the assistant's fresh stored reads.
 * Batch size limited to 50.
 */
export const POST = withRouteContext(
  'transaction.suggest_categories',
  async (request, { supabase, companyId }) => {
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

    const { proposals, assistant_reads } = await proposeForTransactions(supabase, companyId, transactions as Transaction[])
    return NextResponse.json({ template_suggestions: proposals, assistant_reads })
  },
)
