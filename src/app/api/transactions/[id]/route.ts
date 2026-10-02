import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateTransactionTitleSchema } from '@/lib/api/schemas'
import { guardSandbox } from '@/lib/sandbox/guard'
import { deleteTransaction, updateTransaction } from '@/lib/transactions/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

// withRouteContext enforces auth (MFA on hosted), resolves the active
// companyId and rejects viewers via requireWrite. The previous hand-rolled
// session lookup in this handler skipped the MFA gate entirely.
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transaction.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { log, requestId } = ctx

    // Rules (unbooked only, never a bank-synced or file-imported row, never
    // one with match history) live in lib/transactions/manage.ts, shared
    // with DELETE /api/v1/companies/{companyId}/transactions/{id}.
    const outcome = await deleteTransaction({ supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

/**
 * Edit a bank transaction's title (description).
 *
 * Legal under BFL only while the row is a mutable staging label: i.e. NOT yet
 * booked into a verifikat and NOT confirmed-matched to an invoice. Once booked
 * the description is räkenskapsinformation and corrections go through storno
 * (reverseEntry/correctEntry), so the service hard-blocks those rows. The
 * bank's original title is preserved immutably in original_description (set
 * at ingest) and is never written here; passing it back restores the "not
 * edited" tag. Rules in lib/transactions/manage.ts (updateTransaction), shared
 * with PATCH /api/v1/companies/{companyId}/transactions/{id}.
 */
export const PATCH = withRouteContext(
  'transaction.updateTitle',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const validation = await validateBody(request, UpdateTransactionTitleSchema, {
      log,
      operation: 'transaction.updateTitle',
    })
    if (!validation.success) return validation.response

    const outcome = await updateTransaction({ supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log }, id, {
      description: validation.data.description,
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    // Return only what the client renders (data minimisation).
    const { id: txId, description, title_edited_at } = outcome.data
    return NextResponse.json({ data: { id: txId, description, title_edited_at } })
  },
  { requireWrite: true },
)
