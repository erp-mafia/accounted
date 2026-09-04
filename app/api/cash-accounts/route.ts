import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateCashAccountSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { listForCompany } from '@/lib/cash-accounts/service'
import { createManualBankAccount } from '@/lib/cash-accounts/invoice-payee'
import { getCompanyRole } from '@/lib/auth/require-write'

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
 */
export const POST = withRouteContext(
  'cash_accounts.create',
  async (request, { supabase, companyId, log, requestId, user }) => {
    const validation = await validateBody(request, CreateCashAccountSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const roleResult = await getCompanyRole(supabase, user.id, { companyId })
    if (!roleResult.ok) return roleResult.response
    if (!['owner', 'admin'].includes(roleResult.role)) {
      return errorResponseFromCode('FORBIDDEN', log, {
        requestId,
        details: { required_roles: ['owner', 'admin'] },
      })
    }

    const payee = Object.fromEntries(
      Object.entries(body.payee ?? {}).map(([key, value]) => [key, value === '' ? null : value]),
    )

    try {
      const account = await createManualBankAccount(supabase, companyId, user.id, {
        name: body.name,
        currency: body.currency,
        ledger_account: body.ledger_account ?? null,
        invoice_payee: body.invoice_payee,
        payee,
      })
      return NextResponse.json({ data: account }, { status: 201 })
    } catch (err) {
      log.error('cash_accounts create failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
