import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { readAccrualRoom } from '@/lib/bookkeeping/accruals/manual'
import { isInterimBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { accountNumberSchema, saneIsoDateSchema } from '@/lib/invariants/zod'
import { sessionFailureResponse } from '@/lib/operations/session'

const RoomQuerySchema = z.object({
  direction: z.enum(['expense', 'revenue']),
  balance_account: accountNumberSchema.refine(isInterimBalanceAccount, 'Balanskontot måste vara ett 17xx- eller 29xx-konto.'),
  origin_journal_entry_id: z.string().uuid().optional(),
  period_start: saneIsoDateSchema.optional(),
})

/**
 * GET /api/bookkeeping/accruals/available?direction=&balance_account=
 *   [&origin_journal_entry_id=…][&period_start=…]
 *
 * What a new periodisering on the account may still spread (readAccrualRoom):
 * the account's balance less the months not yet posted of its other active
 * plans, never more than the origin verifikat or the ingående balans put
 * there. "Ny periodisering" prefills its amount from it and shows it.
 */
export const GET = withRouteContext(
  'accruals.available',
  async (request, { supabase, companyId, log, requestId }) => {
    const validated = validateQuery(request, RoomQuerySchema, { log, operation: 'accruals.available' })
    if (!validated.success) return validated.response
    const outcome = await readAccrualRoom(supabase, companyId, validated.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
