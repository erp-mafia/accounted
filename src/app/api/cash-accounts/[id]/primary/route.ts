import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { setPrimaryCashAccount } from '@/lib/cash-accounts/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/cash-accounts/[id]/primary
 *
 * Make this account the company's primary. An action, not a field: it takes no
 * body, checks eligibility and flips the flag on two rows in one transaction
 * (make_cash_account_primary) and cannot be combined with anything else.
 *
 * Owner/admin only, same gate as the enabled toggle next to it: the primary is
 * the skattekonto counter leg (__PRIMARY_SEK__) and the account that owns
 * transactions with no cash_account_id in reconciliation. What qualifies is
 * decided inside the RPC, not here; who did it and when lands in audit_log.
 * Only bookings made after the call follow the new primary; nothing posted is
 * read or written. The rules live in lib/cash-accounts/manage.ts, shared with
 * the v1 operation cash-accounts.set-primary and gnubok_set_primary_cash_account.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'cash_accounts.make_primary',
  async (_request, { supabase, companyId, log, requestId, user }, { params }) => {
    const { id } = await params
    const outcome = await setPrimaryCashAccount({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
