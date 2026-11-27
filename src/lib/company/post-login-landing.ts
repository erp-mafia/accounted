'use client'

import { isStartPagePath, type StartPagePath } from '@/lib/company/start-page'

/**
 * Post-login landing (WL-14): asks the server where this session should land
 * when the auth flow has no explicit destination. Byrå staff on their byrå's
 * home domain get '/clients' (the cockpit); everyone else their start page in
 * the active company (lib/company/start-page.ts), '/' unless they chose
 * another. ANY failure (offline, 4xx, malformed payload) degrades to '/', so
 * the flow can never be worse than today's hardcoded push.
 *
 * The answer is whitelisted client-side: only the cockpit and the known start
 * pages are ever returned, so a compromised or confused response cannot
 * redirect the user anywhere else.
 */
export async function resolvePostLoginDestination(): Promise<'/clients' | StartPagePath> {
  try {
    const res = await fetch('/api/clients/landing', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!res.ok) return '/'
    const payload = (await res.json()) as { data?: { destination?: unknown } }
    const destination = payload?.data?.destination
    if (destination === '/clients') return '/clients'
    return isStartPagePath(destination) ? destination : '/'
  } catch {
    return '/'
  }
}
