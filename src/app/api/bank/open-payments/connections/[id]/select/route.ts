import { NextResponse, after } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { selectBankFeedAccounts } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

// The first import runs inside this request (the extended history window the
// bank serves right after the consent); past the wait it finishes in the
// background, so the function must outlive the default 60 s.
export const maxDuration = 300

const SelectSchema = z.object({
  accounts: z
    .array(
      z.object({
        uid: z.string().min(1),
        enabled: z.boolean(),
        /** A BAS 19xx account; null (an unselected account, or "let the allocator choose"). */
        ledger_account: z.string().regex(/^19\d{2}$/).nullish(),
      }),
    )
    .min(1)
    .max(100),
  method: z.enum(['same_device', 'qr']).nullish(),
  personal_number: z.string().max(20).nullish(),
})

/**
 * POST /api/bank/open-payments/connections/:id/select: which accounts to
 * sync, onto which ledgers. Saves the selection, hands over the Enable
 * Banking connection a switch replaces and runs the first import. Svea gets
 * its second consent to sign instead (the answer carries `attempt`).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.select',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const blocked = await requireCapability(supabase, companyId, CAPABILITY.bank_sync)
    if (blocked) return blocked
    const validation = await validateBody(request, SelectSchema)
    if (!validation.success) return validation.response
    const outcome = await selectBankFeedAccounts(
      { supabase, companyId, userId: user.id, log },
      {
        connectionId: id,
        accounts: validation.data.accounts.map((a) => ({ uid: a.uid, enabled: a.enabled, ledgerAccount: a.ledger_account ?? null })),
        method: validation.data.method ?? null,
        signer: signerFromRequest(request, validation.data.personal_number),
        keepAlive: (work) => after(() => work.catch(() => {})),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
