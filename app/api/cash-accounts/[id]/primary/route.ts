import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { makePrimary } from '@/lib/cash-accounts/primary'
import { getCompanyRole } from '@/lib/auth/require-write'
import { UUID_RE } from '@/lib/invariants/uuid'

/** Canonical 404, same envelope as PATCH /api/cash-accounts/[id]. */
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
 * POST /api/cash-accounts/[id]/primary
 *
 * Make this account the company's primary. An action, not a field: it takes no
 * body, flips the flag on two rows in one transaction (set_cash_account_primary)
 * and cannot be combined with anything else.
 *
 * Owner/admin only, same gate as the enabled toggle next to it: the primary is
 * the skattekonto counter leg (__PRIMARY_SEK__) and the account that owns
 * transactions with no cash_account_id in reconciliation. What qualifies
 * lives in makePrimary(), not here.
 * Only bookings made after the call follow the new primary; nothing posted is
 * read or written.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.make_primary',
  async (_request, { supabase, companyId, log, requestId, user }, { params }) => {
    const { id } = await params
    // A non-UUID id can never match a row; answer 404 instead of letting the
    // uuid cast surface as a 500 from Postgres.
    if (!UUID_RE.test(id)) return notFound()

    const roleResult = await getCompanyRole(supabase, user.id, { companyId })
    if (!roleResult.ok) return roleResult.response
    if (!['owner', 'admin'].includes(roleResult.role)) {
      return errorResponseFromCode('FORBIDDEN', log, {
        requestId,
        details: { required_roles: ['owner', 'admin'] },
      })
    }

    try {
      const result = await makePrimary(supabase, companyId, id)
      if (result.ok) return NextResponse.json({ data: result.account })
      if (result.reason === 'not_found') return notFound()
      return errorResponseFromCode('CASH_ACCOUNT_PRIMARY_INELIGIBLE', log, {
        requestId,
        details: { cash_account_id: id, reason: result.reason },
      })
    } catch (err) {
      log.error('cash_accounts make primary failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
