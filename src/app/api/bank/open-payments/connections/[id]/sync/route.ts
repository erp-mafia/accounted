import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { syncBankFeedConnection } from '@/lib/bank-feed/service'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'

// The first read after selection pages through the bank's extended history.
export const maxDuration = 300

/**
 * POST /api/bank/open-payments/connections/:id/sync: "Synka nu". One read with
 * the person present (IP and user agent go to the bank, which then does not
 * count the read against the consent's unattended budget). The first read of
 * a connection takes the extended history window; later ones the gap since
 * the last sync, and a connection synced within 15 minutes answers 429
 * BANK_SYNC_COOLDOWN.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bank_feed.sync',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const blocked = await requireCapability(supabase, companyId, CAPABILITY.bank_sync)
    if (blocked) return blocked
    const outcome = await syncBankFeedConnection(
      { supabase, companyId, userId: user.id, log },
      { connectionId: id, signer: signerFromRequest(request, null) },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
