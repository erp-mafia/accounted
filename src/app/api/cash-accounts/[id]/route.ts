import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { RemoveCashAccountQuerySchema, UpdateCashAccountSchema } from '@/lib/api/schemas'
import { removeCashAccount, updateCashAccount } from '@/lib/cash-accounts/manage'
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

/**
 * DELETE /api/cash-accounts/[id]
 *
 * Remove a bank account that never became bookkeeping, together with its
 * unbooked transactions (#3130): the wrongly synced private or co-holder
 * account. All or nothing, in one database transaction
 * (remove_cash_account); a refusal names the reason in its own code
 * (CASH_ACCOUNT_REMOVE_*, 409) and changes nothing. Underlag attached to the
 * rows stays in Arkiv. ?dry_run=true answers the same checks and what would
 * go without writing, which is what the confirmation dialog shows.
 *
 * Owner/admin only, same gate as the enabled toggle and the primary. The
 * rules live in lib/cash-accounts/manage.ts (removeCashAccount).
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.remove',
  async (request, { supabase, companyId, log, requestId, user }, { params }) => {
    const { id } = await params
    const query = validateQuery(request, RemoveCashAccountQuerySchema)
    if (!query.success) return query.response
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'CASH_ACCOUNT_NOT_FOUND' }, log, requestId)

    const outcome = await removeCashAccount({ supabase, companyId, userId: user.id, log }, id, {
      dryRun: query.data.dry_run === 'true',
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
