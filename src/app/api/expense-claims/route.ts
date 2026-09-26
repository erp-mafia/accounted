import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateExpenseClaimSchema } from '@/lib/api/schemas'
import { listExpenseClaims } from '@/lib/expenses/expense-claims-service'
import { createExpenseClaim } from '@/lib/expenses/expense-claim-actions'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const GET = withRouteContext('expense_claims.list', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const claims = await listExpenseClaims(supabase, companyId, {
    status: status === 'registered' || status === 'paid' ? status : undefined,
  })
  return NextResponse.json({ data: claims })
})

/**
 * POST /api/expense-claims: register an utlägg and post its verifikat. The
 * rules live in lib/expenses/expense-claim-actions.ts, shared with the v1
 * operation expense-claims.create and gnubok_create_expense_claim.
 */
export const POST = withRouteContext(
  'expense_claims.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateExpenseClaimSchema)
    if (!validation.success) return validation.response

    const outcome = await createExpenseClaim({ supabase, companyId, userId: user.id, log }, {
      ...validation.data,
      employee_id: validation.data.employee_id ?? undefined,
      document_id: validation.data.document_id ?? undefined,
      inbox_item_id: validation.data.inbox_item_id ?? undefined,
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
