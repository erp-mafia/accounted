/**
 * PUT /api/bookkeeping/accounts/[number]: sparse edit of one account.
 * DELETE /api/bookkeeping/accounts/[number]: hard-delete an unused,
 * non-system account; one with journal lines in this company must be
 * deactivated instead (PUT is_active=false).
 *
 * The rules live in lib/bookkeeping/chart-of-accounts-service.ts, shared with
 * the v1 operations accounts.update / accounts.delete and their MCP tools.
 * Success shapes are the legacy `{ data }` / `{ success: true }` the kontoplan
 * UI reads; failures answer the canonical `{ error: { code, message } }`.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { UpdateAccountSchema } from '@/lib/api/schemas'
import { deleteAccount, updateAccount } from '@/lib/bookkeeping/chart-of-accounts-service'
import { sessionFailureResponse } from '@/lib/operations/session'

export const DELETE = withRouteContext(
  'bookkeeping.accounts.delete',
  async (_request, ctx, { params }: { params: Promise<{ number: string }> }) => {
    const { number } = await params
    const { supabase, companyId, user, log, requestId } = ctx

    const outcome = await deleteAccount({ supabase, companyId, userId: user.id, log }, number)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

export const PUT = withRouteContext(
  'bookkeeping.accounts.update',
  async (request, ctx, { params }: { params: Promise<{ number: string }> }) => {
    const { number } = await params
    const { supabase, companyId, user, log, requestId } = ctx

    // Only the fields the caller actually named may reach the update.
    // UpdateAccountSchema carries no .default() today, so sparsePatchBody is
    // a no-op here: it is the structural guarantee that adding one later
    // cannot make a PUT that renames an account also rewrite its VAT code or
    // SRU mapping. An explicit null (clearing sru_code, VAT defaults, or
    // descriptions) still survives.
    const validation = await validateBody(request, sparsePatchBody(UpdateAccountSchema), {
      log,
      operation: 'bookkeeping.accounts.update',
    })
    if (!validation.success) return validation.response

    const outcome = await updateAccount({ supabase, companyId, userId: user.id, log }, number, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
