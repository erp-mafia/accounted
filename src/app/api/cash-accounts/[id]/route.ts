import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateCashAccountSchema } from '@/lib/api/schemas'
import { updateCashAccount } from '@/lib/cash-accounts/manage'
import { sessionFailureResponse } from '@/lib/operations/session'
import { UUID_RE } from '@/lib/invariants/uuid'

/**
 * PATCH /api/cash-accounts/[id]
 *
 * Three independent concerns on one of the company's bank accounts:
 *   - voucher_series: the verifikationsserie override (any writer role).
 *   - payee fields + invoice_payee + name: what customer invoices print
 *     (owner/admin only, same gate as the payment instructions on
 *     /api/settings; members never control where customers pay).
 *   - enabled (owner/admin only, like the payee fields): opt an account no
 *     bank connection holds out of the Konton overview and the booking flows
 *     once the company stops using it. Never a connection-held account
 *     (409); never the primary or one with unbooked transactions (400).
 * Ledger account and primary flag have their own guarded flows. The rules
 * live in lib/cash-accounts/manage.ts, shared with the v1 operation
 * cash-accounts.update and gnubok_update_cash_account.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.update',
  async (request, { supabase, companyId, log, requestId, user }, { params }) => {
    const { id } = await params
    // A non-UUID id can never match a row: 404 before the body is read.
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'CASH_ACCOUNT_NOT_FOUND' }, log, requestId)
    const validation = await validateBody(request, UpdateCashAccountSchema)
    if (!validation.success) return validation.response

    const outcome = await updateCashAccount({ supabase, companyId, userId: user.id, log }, id, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
