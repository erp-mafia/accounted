import 'server-only'

import { requestHost, resolveTrustedAppOrigin } from '@/lib/domains/trusted-app-origin'

/**
 * The origin a bank's redirect return should land on: the host the request
 * came to, when it is one Accounted serves (the canonical app, this
 * deployment's own hosts, a registered white-label domain), else the
 * canonical origin. No token travels in the return URL, so a brand lookup
 * that fails degrades to canonical rather than stopping the signing.
 */
export function returnOriginFor(request: Request): Promise<string> {
  return resolveTrustedAppOrigin(requestHost(request), { onLookupFailure: 'canonical' })
}
