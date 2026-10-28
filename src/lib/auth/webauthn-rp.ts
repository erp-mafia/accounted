import 'server-only'

import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'

/**
 * The WebAuthn relying party for a request: the trusted app origin it was
 * addressed to (never a raw Host header). A key is bound to this hostname,
 * so a key enrolled on one brand domain does not answer on another.
 */
export async function webauthnRelyingParty(
  request: Request,
): Promise<{ rpId: string; rpOrigins: string[] }> {
  const origin = await resolveRequestAppOrigin(request, { onLookupFailure: 'canonical' })
  return { rpId: new URL(origin).hostname, rpOrigins: [origin] }
}
