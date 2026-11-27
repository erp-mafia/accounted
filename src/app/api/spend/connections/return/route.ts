import { NextResponse, after } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { requireFlowInitiator } from '@/lib/auth/oauth-flow-binding'
import { resolveTrustedAppOrigin } from '@/lib/domains/trusted-app-origin'
import { createLogger } from '@/lib/logger'
import { completeSpendConnectReturn, findPendingSpendConnection, spendConnectDeps } from '@/lib/spend/service'
import { syncSpendConnection } from '@/lib/spend/sync'

const log = createLogger('api/spend/connections/return')

/**
 * GET /api/spend/connections/return?state=...&result=...
 *
 * Where Accounted Connect sends the browser back after the provider's consent
 * page. A real route (not JSON): the browser arrives here by redirect.
 *
 *   1. state names the pending connection (only its hash is stored);
 *   2. the browser must belong to the person who started connecting
 *      (requireFlowInitiator: a shared consent link can never attach a
 *      provider company to someone else's books);
 *   3. Connect redeems state and result for the connection handle, and the
 *      pending row becomes the live connection;
 *   4. the first fetch runs after the answer, and the person lands on the
 *      connection's settings page, on the origin they started from.
 *
 * Deliberately not withRouteContext: the start route already ran the
 * MFA-enforcing guard for this user, and a provider redirect has no MFA
 * prompt to send them to (same reasoning as the partner OAuth callbacks).
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const state = url.searchParams.get('state') ?? ''
  const result = url.searchParams.get('result') ?? ''
  const canonical = await resolveTrustedAppOrigin(null, { onLookupFailure: 'canonical' })
  const settingsUrl = (origin: string, query: string) => NextResponse.redirect(`${origin}/settings/spend?${query}`)

  if (state.length < 16 || result.length < 16 || state.length > 200 || result.length > 256) {
    return settingsUrl(canonical, 'spend_error=SPEND_CONNECT_INVALID')
  }
  const pending = await findPendingSpendConnection(state)
  if (!pending || !pending.created_by) return settingsUrl(canonical, 'spend_error=SPEND_CONNECT_EXPIRED')

  // The stored origin is re-validated: the app or a registered brand domain, never an arbitrary URL.
  const origin = await resolveTrustedAppOrigin(pending.pending_return_origin, { onLookupFailure: 'canonical' })
  const initiator = await requireFlowInitiator(request, pending.created_by, { flow: 'spend.return', returnOrigin: origin })
  if (!initiator.ok) {
    if (initiator.reason === 'mismatch') return settingsUrl(origin, 'spend_error=SPEND_CONNECT_WRONG_USER')
    return initiator.response
  }

  const outcome = await completeSpendConnectReturn(pending, { state, result }, log)
  if (!outcome.ok) return settingsUrl(origin, `spend_error=${outcome.code}`)

  after(async () => {
    try {
      await syncSpendConnection(createServiceClientNoCookies(), outcome.connectionId, { log, connect: spendConnectDeps() })
    } catch (err) {
      log.error('first spend fetch after connect failed', err as Error, { connectionId: outcome.connectionId })
    }
  })
  return settingsUrl(origin, 'spend_connected=1')
}
