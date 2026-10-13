import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { batchAllocationsFromParts, readTransactionParts, type TransactionPartsResponse } from '@/lib/transactions/parts-read'
import { BANKGIRO_SPLIT_METHOD } from '@/lib/transactions/part-suggestions'

/**
 * GET /api/transactions/[id]/parts
 *
 * The Bankgirot split of a bank row (bank_transaction_parts): one part per
 * payer or payee with the open invoice ingest suggested for it (number,
 * counterparty, what is left to pay), so the drawer can list the split and
 * prefill the batch allocation (MatchAllocationDialog) from it. Empty for a
 * row without a split.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.parts.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const { data: tx, error: txError } = await supabase
      .from('transactions')
      .select('id, potential_match_method')
      .eq('company_id', companyId)
      .eq('id', id)
      .maybeSingle()
    if (txError) throw txError
    if (!tx) return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })

    const parts = await readTransactionParts(supabase, companyId, id)
    const allocations =
      tx.potential_match_method === BANKGIRO_SPLIT_METHOD
        ? batchAllocationsFromParts(
            parts.map((p) => ({
              amount: p.amount,
              suggested_invoice_id: p.suggested_invoice?.kind === 'customer_invoice' ? p.suggested_invoice.invoice_id : null,
              suggested_supplier_invoice_id: p.suggested_invoice?.kind === 'supplier_invoice' ? p.suggested_invoice.invoice_id : null,
            })),
          )
        : null
    const data: TransactionPartsResponse = { parts, batch_suggestion: allocations ? { allocations } : null }
    return NextResponse.json({ data })
  },
)
