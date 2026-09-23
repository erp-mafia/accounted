'use client'

/**
 * Post-login landing (WL-14): asks the server where this session should land
 * when the auth flow has no explicit destination. Byrå staff on their byrå's
 * home domain get '/clients' (the cockpit); everyone else '/': and ANY
 * failure (offline, 4xx, malformed payload) degrades to '/', so the
 * non-byrå flow can never be worse than today's hardcoded push.
 *
 * The answer is whitelisted client-side: only the two known destinations are
 * ever returned, so a compromised or confused response cannot redirect the
 * user anywhere else.
 */
export async function resolvePostLoginDestination(): Promise<'/clients' | '/'> {
  try {
    const res = await fetch('/api/clients/landing', {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!res.ok) return '/'
    const payload = (await res.json()) as { data?: { destination?: unknown } }
    return payload?.data?.destination === '/clients' ? '/clients' : '/'
  } catch {
    return '/'
  }
}
