import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MatchBatchSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { sessionFailureResponse } from '@/lib/operations/session'
import { matchTransactionBatch } from '@/lib/transactions/match-batch'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-batch
 *
 * Allocate one bank transaction across N customer OR N supplier invoices.
 * Builds a single combined verifikat (samlingsverifikation) and inserts N
 * payment rows via the match_batch_allocate PL/pgSQL RPC.
 *
 * The rules (invoice document type, already-explained guard, kontantmetoden,
 * the RPC, the per-allocation events and suggestion cleanup) live in
 * lib/transactions/match-batch.ts, shared with
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-batch.
 */
export const POST = withRouteContext(
  'transaction.match_batch',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchBatchSchema, {
      log,
      operation: 'transaction.match_batch',
    })
    if (!validation.success) return validation.response

    const outcome = await matchTransactionBatch(
      { supabase, companyId: companyId!, userId: user.id, log },
      transactionId,
      validation.data,
      { via: 'dashboard_force' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log.child({ transactionId }), requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
