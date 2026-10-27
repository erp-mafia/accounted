import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { RemoveCashAccountQuerySchema } from '@/lib/api/schemas'
import { archiveCashAccount } from '@/lib/cash-accounts/manage'
import { sessionFailureResponse } from '@/lib/operations/session'
import { UUID_RE } from '@/lib/invariants/uuid'

/**
 * POST /api/cash-accounts/[id]/archive
 *
 * Archive a bank account that removal must keep (PH 222): a mistaken
 * connection whose ledger already holds history, or with a row booked,
 * ignored or matched. The account is turned off and leaves Konton and the
 * booking flows; every row stays (archive_cash_account). A refusal names the
 * reason in its own code (409) and changes nothing. ?dry_run=true answers the
 * same checks without writing, as for DELETE.
 *
 * Owner/admin only, same gate as removal. The rules live in
 * lib/cash-accounts/manage.ts (archiveCashAccount).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.archive',
  async (request, { supabase, companyId, log, requestId, user }, { params }) => {
    const { id } = await params
    const query = validateQuery(request, RemoveCashAccountQuerySchema)
    if (!query.success) return query.response
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'CASH_ACCOUNT_NOT_FOUND' }, log, requestId)

    const outcome = await archiveCashAccount({ supabase, companyId, userId: user.id, log }, id, {
      dryRun: query.data.dry_run === 'true',
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
