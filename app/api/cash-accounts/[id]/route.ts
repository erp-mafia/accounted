import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateCashAccountVoucherSeriesSchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { setVoucherSeries } from '@/lib/cash-accounts/service'
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

/**
 * PATCH /api/cash-accounts/[id]
 *
 * Sets or clears the verifikationsserie override on one of the company's
 * bank accounts. Only this one field is editable here: ledger account and
 * primary flag have their own guarded flows (unique constraint, atomic RPC).
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.update',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    // A non-UUID id can never match a row; answer 404 instead of letting the
    // uuid cast surface as a 500 from Postgres.
    if (!UUID_RE.test(id)) return notFound()
    const validation = await validateBody(request, UpdateCashAccountVoucherSeriesSchema)
    if (!validation.success) return validation.response

    let updated
    try {
      updated = await setVoucherSeries(supabase, companyId, id, validation.data.voucher_series)
    } catch (err) {
      log.error('cash_accounts voucher_series update failed', err as Error)
      return errorResponse(err, log, { requestId })
    }

    if (!updated) return notFound()

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
