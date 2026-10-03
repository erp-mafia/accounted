import 'server-only'

/**
 * Supabase Auth (GoTrue) rate limits by client IP. Since the session became
 * server-held, sign-in, OTP and MFA verification and every token refresh
 * reach GoTrue from this server, so all users behind one egress IP would
 * share one bucket (sign-ins 30 per 5 minutes, verifications 30 per 5
 * minutes, refreshes 150 per 5 minutes, per IP by default).
 *
 * Supabase's "IP address forwarding" fixes that: a request made with a
 * SECRET API key (sb_secret_...) may carry `Sb-Forwarded-For` with the end
 * user's IP, and GoTrue rate-limits by that instead. It needs the project
 * setting Authentication > Rate Limits > IP Address Forwarding
 * (security_sb_forwarded_for_enabled); publishable and legacy anon or
 * service_role keys are not accepted for it.
 *
 * authForwardingFetch() returns a fetch for the user-session Supabase
 * clients (server.ts, the proxy, /auth/callback) that does exactly that, for
 * GoTrue requests ONLY:
 *
 * - URL path under /auth/v1/ on the configured Supabase origin: the apikey
 *   header becomes SUPABASE_SECRET_KEY and Sb-Forwarded-For carries the
 *   validated client IP. Authorization is left as it is (the user's access
 *   token, or the public key for anonymous calls), so nothing about who the
 *   request acts as changes.
 * - Everything else (PostgREST /rest/v1, Storage, Realtime, Functions, any
 *   other origin): passed through untouched. The secret key would bypass
 *   RLS there, so it must never be attached to those requests.
 *
 * Off (returns undefined, i.e. today's behaviour) when SUPABASE_SECRET_KEY is
 * unset or not an sb_secret_ key (local dev, self-hosted, CI), and per
 * request when no valid client IP is known. The key is never logged.
 */

const SECRET_KEY_PREFIX = 'sb_secret_'
const AUTH_PATH_PREFIX = '/auth/v1/'
export const FORWARDED_FOR_HEADER = 'sb-forwarded-for'

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * A bare IPv4 or IPv6 address, as the edge writes it (no port, no brackets,
 * no zone id). IPv6 is checked by the WHATWG URL parser, which accepts only
 * well-formed literals; the IPv4 form is matched strictly because the URL
 * parser would also accept shorthands like "1" or "0x7f.1".
 */
export function isIpAddress(value: string): boolean {
  if (!value || value.length > 45) return false
  if (IPV4.test(value)) return true
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2
  } catch {
    return false
  }
}

/**
 * The end user's IP as the edge reports it: the first hop of
 * x-forwarded-for (Vercel sets it to the connecting client), else
 * x-real-ip. Null when neither holds a valid address.
 */
export function clientIpFromHeaders(headers: Pick<Headers, 'get'> | null | undefined): string | null {
  const forwarded = headers?.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return isIpAddress(forwarded) ? forwarded : null
  const real = headers?.get('x-real-ip')?.trim()
  return real && isIpAddress(real) ? real : null
}

function configuredSecretKey(): string | null {
  const key = process.env.SUPABASE_SECRET_KEY?.trim()
  return key && key.startsWith(SECRET_KEY_PREFIX) ? key : null
}

function supabaseOrigin(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Whether a request goes to GoTrue on the configured Supabase project. */
function isAuthRequest(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.origin === origin && parsed.pathname.startsWith(AUTH_PATH_PREFIX)
  } catch {
    return false
  }
}

/**
 * The fetch to hand a user-session Supabase client as `global.fetch`, or
 * undefined when forwarding is off (then the client keeps the default fetch
 * and behaves exactly as before).
 */
export function authForwardingFetch(
  clientIp: string | null | undefined,
  baseFetch: typeof fetch = fetch,
): typeof fetch | undefined {
  const secretKey = configuredSecretKey()
  const origin = supabaseOrigin()
  if (!secretKey || !origin) return undefined

  const ip = clientIp && isIpAddress(clientIp) ? clientIp : null

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!ip || !isAuthRequest(requestUrl(input), origin)) return baseFetch(input, init)

    const headers = new Headers(
      init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined),
    )
    headers.set('apikey', secretKey)
    headers.set(FORWARDED_FOR_HEADER, ip)
    return baseFetch(input, { ...init, headers })
  }) as typeof fetch
}
