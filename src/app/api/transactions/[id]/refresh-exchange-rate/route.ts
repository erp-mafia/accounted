import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { guardSandbox } from '@/lib/sandbox/guard'
import { sessionFailureResponse } from '@/lib/operations/session'
import { refreshTransactionExchangeRate } from '@/lib/transactions/manage'

/**
 * POST /api/transactions/[id]/refresh-exchange-rate
 *
 * Fill in the Riksbanken rate and SEK amount of an unbooked foreign-currency
 * transaction that lacks them. Rules in lib/transactions/manage.ts, shared
 * with POST /api/v1/companies/{companyId}/transactions/{id}/refresh-exchange-rate.
 * The sandbox guard stays here: the sandbox never calls Riksbanken.
 */
export const POST = withRouteContext(
  'transaction.refreshExchangeRate',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId, user } = ctx

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const outcome = await refreshTransactionExchangeRate({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data.transaction })
  },
  { requireWrite: true },
)
