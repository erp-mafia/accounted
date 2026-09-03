import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateCashAccountSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { setVoucherSeries } from '@/lib/cash-accounts/service'
import { updateCashAccountPayee, type PayeeUpdate } from '@/lib/cash-accounts/invoice-payee'
import { getCompanyRole } from '@/lib/auth/require-write'
import { UUID_RE } from '@/lib/invariants/uuid'

/** Canonical 404 for an id that is not one of the company's bank accounts. */
function notFound(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: 'CASH_ACCOUNT_NOT_FOUND',
        message: 'Bankkontot hittades inte.',
        message_en: 'Bank account not found.',
      },
    },
    { status: 404 },
  )
}

const PAYEE_KEYS = [
  'name',
  'bank_name',
  'clearing_number',
  'account_number',
  'bankgiro',
  'plusgiro',
  'swish',
  'iban',
  'bic',
  'bank_code',
  'foreign_account_number',
  'invoice_payee',
] as const

/**
 * PATCH /api/cash-accounts/[id]
 *
 * Two independent concerns on one of the company's bank accounts:
 *   - voucher_series: the verifikationsserie override (any writer role).
 *   - payee fields + invoice_payee + name: what customer invoices print
 *     (owner/admin only, same gate as the payment instructions on
 *     /api/settings; members never control where customers pay).
 * Ledger account and primary flag have their own guarded flows.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.update',
  async (request, { supabase, companyId, log, requestId, user }, { params }) => {
    const { id } = await params
    // A non-UUID id can never match a row; answer 404 instead of letting the
    // uuid cast surface as a 500 from Postgres.
    if (!UUID_RE.test(id)) return notFound()
    const validation = await validateBody(request, UpdateCashAccountSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const payeeUpdate: PayeeUpdate = {}
    for (const key of PAYEE_KEYS) {
      if (body[key] !== undefined) {
        // '' from a cleared form field clears the column.
        ;(payeeUpdate as Record<string, unknown>)[key] = body[key] === '' ? null : body[key]
      }
    }
    const touchesPayee = Object.keys(payeeUpdate).length > 0

    if (touchesPayee) {
      const roleResult = await getCompanyRole(supabase, user.id, { companyId })
      if (!roleResult.ok) return roleResult.response
      if (!['owner', 'admin'].includes(roleResult.role)) {
        return errorResponseFromCode('FORBIDDEN', log, {
          requestId,
          details: { required_roles: ['owner', 'admin'] },
        })
      }
    }

    let updated = null
    try {
      if (body.voucher_series !== undefined) {
        updated = await setVoucherSeries(supabase, companyId, id, body.voucher_series)
        if (!updated) return notFound()
      }
      if (touchesPayee) {
        updated = await updateCashAccountPayee(supabase, companyId, id, payeeUpdate)
      }
    } catch (err) {
      log.error('cash_accounts update failed', err as Error)
      return errorResponse(err, log, { requestId })
    }

    if (!updated) return notFound()

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
