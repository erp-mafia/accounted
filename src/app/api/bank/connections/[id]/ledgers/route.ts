import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { ChangeBankLedgersQuerySchema, ChangeBankLedgersSchema } from '@/lib/api/schemas'
import { changeBankAccountLedgers } from '@/lib/cash-accounts/ledger-change'
import { sessionFailureResponse } from '@/lib/operations/session'
import { UUID_RE } from '@/lib/invariants/uuid'

/**
 * PATCH /api/bank/connections/[id]/ledgers
 *
 * Which 19xx ledger account each named synced bank account of an active bank
 * connection books on from now on, whichever service reads the bank (Enable
 * Banking or Open Payments). Before this, an Open Payments connection had no
 * way to change it after the first choice (crm#1395, crm#1387, PH 211).
 * Posted verifikat stay where they are; unbooked transactions follow the
 * account. ?dry_run=true answers the moves (with booked and unbooked counts)
 * without writing: the confirmation dialog's preview. The rules live in
 * lib/cash-accounts/ledger-change.ts; the save is save_bank_account_selection,
 * as for the bank pickers.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_connections.ledgers',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const query = validateQuery(request, ChangeBankLedgersQuerySchema)
    if (!query.success) return query.response
    // A non-UUID id can never match a row: 404 before the body is read.
    if (!UUID_RE.test(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
    const validation = await validateBody(request, ChangeBankLedgersSchema)
    if (!validation.success) return validation.response

    const outcome = await changeBankAccountLedgers(
      { supabase, companyId, userId: user.id, log },
      { connectionId: id, accounts: validation.data.accounts },
      { dryRun: query.data.dry_run === 'true' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
