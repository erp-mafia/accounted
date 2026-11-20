import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateCashAccountRequestSchema, splitCreateCashAccountRequest } from '@/lib/api/schemas'
import { listForCompany } from '@/lib/cash-accounts/service'
import { createCardAccount, createCashAccount } from '@/lib/cash-accounts/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/cash-accounts
 *
 * Returns the active company's cash accounts (cash_accounts table). Used by the
 * reconciliation surfaces (via useCashAccounts) and any other surface that needs
 * the canonical list of routable cash accounts.
 UI panels that just display PSD2
 * connection state may still read bank_connections.accounts_data until that
 * column is dropped in a follow-up migration.
 *
 * Query params:
 *   - enabled_only=true → only accounts with enabled=true (default returns all)
 */
export const GET = withRouteContext('cash_accounts.list', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const url = new URL(request.url)
  const enabledOnly = url.searchParams.get('enabled_only') === 'true'

  const accounts = await listForCompany(supabase, companyId, { enabledOnly })
  return NextResponse.json({ data: accounts })
})

/**
 * POST /api/cash-accounts
 *
 * A bank account the user types in (no bank connection): name, currency and
 * the payee details customers pay to. Gets the next free 19xx ledger slot
 * for its currency unless one is given. Owner/admin only: it becomes a
 * printable payee.
 *
 * With kind 'card': a company card (företagskort) on a liability account
 * (2480-2489, 2890, 2894, 2896, 2899), the suggested one unless given. Also
 * owner/admin only. The rules live in lib/cash-accounts/manage.ts, shared
 * with the v1 operation cash-accounts.create and gnubok_create_cash_account.
 */
export const POST = withRouteContext(
  'cash_accounts.create',
  async (request, { supabase, companyId, log, requestId, user }) => {
    const validation = await validateBody(request, CreateCashAccountRequestSchema)
    if (!validation.success) return validation.response

    const ctx = { supabase, companyId, userId: user.id, log }
    const split = splitCreateCashAccountRequest(validation.data)
    const outcome = split.kind === 'card'
      ? await createCardAccount(ctx, split.input)
      : await createCashAccount(ctx, split.input)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
