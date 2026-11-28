import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from './api-keys'
import { partnerClientValue, partnerSlugOf } from './oauth-partner-clients'
import { createLogger } from '@/lib/logger'

/**
 * Client authentication for the MCP OAuth endpoints (RFC 6749 section 2.3.1).
 *
 * A partner client (oauth_partner_clients) that has been issued a secret
 * (issue_oauth_partner_client_secret, migration 20261127153716) is a
 * confidential client. Its client_id is its slug, and it authenticates with
 * that and its secret on every code exchange and every refresh, by HTTP
 * Basic (client_secret_basic) or in the form body (client_secret_post). PKCE
 * stays required for it too. Every other client is public: it is asked for
 * no credentials, and whatever it sends is not read, so PKCE alone binds its
 * code, as before.
 *
 * Whether a client holds a secret, and whether a presented one is live, is
 * answered by the database (oauth_client_authentication); only the SHA-256
 * of a presented secret leaves this process.
 */

const log = createLogger('mcp-oauth/client-auth')

export type ClientSecretMethod = 'client_secret_basic' | 'client_secret_post'

/** The client credentials one token request carries. */
export type PresentedClient =
  | { kind: 'none' }
  | {
      kind: 'secret'
      method: ClientSecretMethod
      clientId: string
      /** SHA-256 (hex) of the presented secret. */
      secretHash: string
    }
  | {
      /** Credentials that cannot be read, or two methods at once. */
      kind: 'malformed'
      error: 'invalid_request' | 'invalid_client'
      description: string
    }

/** SHA-256 (hex) of a client secret: the form oauth_partner_client_secrets stores. */
export function hashClientSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** application/x-www-form-urlencoded decoding (RFC 6749 appendix B); throws on a bad escape. */
function formDecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '))
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

type BasicRead =
  | { kind: 'absent' }
  | { kind: 'credentials'; clientId: string; secret: string }
  | { kind: 'malformed'; description: string }

/**
 * The Basic credentials of an Authorization header. Another scheme is not
 * client authentication and reads as absent, and so does an empty password:
 * RFC 6749 section 2.3.1 lets a client without a secret leave it out, and a
 * public client that sends `client_id:` is a public client.
 */
function readBasic(header: string | null): BasicRead {
  if (!header) return { kind: 'absent' }
  const match = /^basic(?:\s+(.*))?$/i.exec(header.trim())
  if (!match) return { kind: 'absent' }
  const token = (match[1] ?? '').trim()
  const malformed = { kind: 'malformed', description: 'The Authorization header carries no readable Basic credentials' } as const
  if (!BASE64.test(token)) return malformed
  const decoded = Buffer.from(token, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return malformed
  let clientId: string
  let secret: string
  try {
    clientId = formDecode(decoded.slice(0, colon))
    secret = formDecode(decoded.slice(colon + 1))
  } catch {
    // A bad percent escape is an unreadable credential, not a failure: it is
    // reported as malformed, which refuses a client that must authenticate.
    return malformed
  }
  if (secret === '') return { kind: 'absent' }
  if (clientId === '') return malformed
  return { kind: 'credentials', clientId, secret }
}

/**
 * The client credentials of a token request: HTTP Basic, or client_id and
 * client_secret in the body (RFC 6749 section 2.3.1). Never refuses a request by
 * itself: a malformed or doubled credential only matters for a client that
 * holds a secret, which is refused for it (clientAuthenticationError).
 */
export function readClientCredentials(headers: Headers, params: URLSearchParams): PresentedClient {
  const basic = readBasic(headers.get('authorization'))
  const bodySecret = params.get('client_secret')
  const bodyClientId = params.get('client_id')
  const hasBodySecret = bodySecret !== null && bodySecret !== ''

  // "The client MUST NOT use more than one authentication method in each
  // request" (RFC 6749 section 2.3).
  if (basic.kind !== 'absent' && hasBodySecret) {
    return { kind: 'malformed', error: 'invalid_request', description: 'Use one client authentication method, not two' }
  }
  if (basic.kind === 'malformed') {
    return { kind: 'malformed', error: 'invalid_client', description: basic.description }
  }
  if (basic.kind === 'credentials') {
    if (bodyClientId !== null && bodyClientId !== basic.clientId) {
      return { kind: 'malformed', error: 'invalid_request', description: 'client_id does not match the authenticated client' }
    }
    return {
      kind: 'secret',
      method: 'client_secret_basic',
      clientId: basic.clientId,
      secretHash: hashClientSecret(basic.secret),
    }
  }
  if (hasBodySecret) {
    if (!bodyClientId) {
      return { kind: 'malformed', error: 'invalid_request', description: 'client_secret requires client_id' }
    }
    return {
      kind: 'secret',
      method: 'client_secret_post',
      clientId: bodyClientId,
      secretHash: hashClientSecret(bodySecret),
    }
  }
  return { kind: 'none' }
}

export type GrantClientAuthentication = 'public' | 'authenticated' | 'refused' | 'unavailable'

/**
 * How a token request stands with the client its code or grant belongs to
 * (`client` in the api_keys.client form). Only a partner client can hold a
 * secret, so any other client is 'public' without a database call.
 * 'unavailable' is a failed lookup: the caller refuses the request rather
 * than treat the client as public.
 */
export async function authenticateGrantClient(
  supabase: SupabaseClient,
  client: string | null,
  presented: PresentedClient,
): Promise<GrantClientAuthentication> {
  if (partnerSlugOf(client) === null) return 'public'
  const { data, error } = await supabase.rpc('oauth_client_authentication', {
    p_client: client,
    p_client_id: presented.kind === 'secret' ? presented.clientId : null,
    p_client_secret_hash: presented.kind === 'secret' ? presented.secretHash : null,
  })
  if (error) {
    log.error('client authentication lookup failed', { client, code: error.code })
    return 'unavailable'
  }
  return data === 'public' || data === 'authenticated' ? data : 'refused'
}

/**
 * The token endpoint's answer to a request that had to authenticate its
 * client and did not (RFC 6749 section 5.2): invalid_client with 401 and a Basic
 * challenge, which section 5.2 requires when the client tried the
 * Authorization header and allows otherwise, or invalid_request for
 * credentials sent two ways at once.
 */
export function clientAuthenticationError(presented: PresentedClient): NextResponse {
  if (presented.kind === 'malformed' && presented.error === 'invalid_request') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: presented.description },
      { status: 400 },
    )
  }
  return NextResponse.json(
    { error: 'invalid_client', error_description: 'Client authentication failed' },
    { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="oauth"' } },
  )
}

/**
 * The authorize endpoint's refusal of a request for a partner client that
 * holds a secret under a client_id that is not the partner's: an invalid
 * client identifier is shown to the resource owner, never redirected (RFC
 * 6749 section 4.1.2.1). Null when the request may go on. A failed lookup
 * refuses nothing here: the code is bound to the partner either way, and the
 * token endpoint, which fails closed, demands the secret before exchanging it.
 */
export async function refuseForeignPartnerClientId(
  slug: string,
  clientId: string | null,
  supabase?: SupabaseClient,
): Promise<NextResponse | null> {
  if (clientId === slug) return null
  let holdsSecret = false
  try {
    const client = supabase ?? createServiceClientNoCookies()
    const { data, error } = await client.rpc('oauth_client_has_secret', { p_client: partnerClientValue(slug) })
    if (error) log.warn('partner secret lookup failed at authorize', { slug, code: error.code })
    holdsSecret = !error && data === true
  } catch (err) {
    log.warn('partner secret lookup threw at authorize', { slug, message: err instanceof Error ? err.message : String(err) })
  }
  if (!holdsSecret) return null
  return NextResponse.json(
    { error: 'invalid_request', error_description: 'client_id is not the client this redirect_uri belongs to' },
    { status: 400 },
  )
}
