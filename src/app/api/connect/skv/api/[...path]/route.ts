import { NextResponse } from 'next/server'
import { withConnectorAuth, type ConnectorContext } from '@/lib/connect/hosted/with-connector-auth'
import { reserveUpstream } from '@/lib/connect/hosted/upstream-budget'
import { findByHandle, touchConnection } from '@/lib/connect/hosted/ledger'
import { SKV_API_BASES, skvGatewayHeaders } from '@/lib/connect/upstreams/skatteverket-oauth'

/**
 * Skatteverket data proxy for self-hosted instances.
 *
 *   ANY /api/connect/skv/api/<service>/<path>
 *   Authorization: Bearer <the END USER's SKV access token, from the instance>
 *   X-Connector-Key: gnubok_ck_...            (the instance's key auth)
 *
 * The instance holds the user token (it did the BankID flow through our
 * broker); it presents that token as the upstream Bearer while proving its
 * own subscription with X-Connector-Key. The proxy checks that the presented
 * token belongs to a connection this key owns (ledger), then adds Arcim's
 * API-gateway client credentials (Client_Id/Client_Secret) and forwards to
 * the right SKV backing API. Arcim's gateway secret never leaves us.
 *
 * <service> is one of the SKV_API_BASES keys (moms, skattekonto,
 * agd-inlamning, agd-period): an allowlist, never an open passthrough.
 */

const FETCH_TIMEOUT_MS = 20_000

function requireScope(ctx: ConnectorContext): NextResponse | null {
  if (ctx.key.scopes.includes('skatteverket')) return null
  return NextResponse.json({ error: 'This connector key does not include Skatteverket', code: 'CONNECTOR_SCOPE_MISSING' }, { status: 403 })
}

function splitPath(request: Request): { service: string; rest: string; query: string } | null {
  const marker = '/api/connect/skv/api'
  const idx = request.url.indexOf(marker)
  if (idx === -1) return null
  const after = request.url.slice(idx + marker.length)
  const [pathPart, ...q] = after.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  if (segments.length === 0) return null
  // Traversal guard: a '.'/'..' segment (raw or percent-encoded) would let
  // the proxied URL escape the allowlisted service base once fetch
  // normalizes it. Decode each segment and reject dot segments and anything
  // that decodes to contain a path separator.
  for (const seg of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(seg)
    } catch {
      return null
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return null
  }
  const [service, ...restSegs] = segments
  return { service, rest: `/${restSegs.join('/')}`, query: q.length ? `?${q.join('?')}` : '' }
}

/** The end-user SKV token the instance forwards, from the upstream-Authorization header. */
function userToken(request: Request): string | null {
  const h = request.headers.get('x-connector-upstream-authorization') || request.headers.get('authorization')
  if (!h?.startsWith('Bearer ')) return null
  return h.slice(7).trim() || null
}

async function handle(request: Request, ctx: ConnectorContext): Promise<Response> {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError

  const parts = splitPath(request)
  if (!parts || !(parts.service in SKV_API_BASES)) {
    return NextResponse.json({ error: 'Unknown Skatteverket service', code: 'CONNECTOR_PATH_NOT_ALLOWED' }, { status: 403 })
  }
  const token = userToken(request)
  if (!token) {
    return NextResponse.json({ error: 'Missing user token', code: 'CONNECTOR_UPSTREAM_TOKEN_MISSING' }, { status: 400 })
  }
  const owned = await findByHandle(ctx.supabase, { keyId: ctx.key.id, service: 'skatteverket', handle: token })
  if (!owned) {
    return NextResponse.json({ error: 'Unknown Skatteverket connection for this key', code: 'CONNECTOR_NOT_OWNED' }, { status: 404 })
  }
  const budget = await reserveUpstream(ctx.supabase, 'skatteverket')
  if (!budget.ok) {
    return NextResponse.json({ error: 'Skatteverket connector is busy', code: 'CONNECTOR_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(budget.retryAfterSec) } })
  }
  await touchConnection(ctx.supabase, owned.id)

  const url = `${SKV_API_BASES[parts.service]()}${parts.rest}${parts.query}`
  const contentType = request.headers.get('x-connector-upstream-content-type') || request.headers.get('content-type') || 'application/json'
  const method = request.method
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const body = hasBody ? await request.text() : undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      // A followed redirect would resend the gateway Client_Secret headers.
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...skvGatewayHeaders(),
        ...(hasBody ? { 'Content-Type': contentType } : {}),
      },
      ...(body !== undefined && body.length > 0 ? { body } : {}),
    })
    const text = await res.text()
    if ([204, 205, 304].includes(res.status)) return new NextResponse(null, { status: res.status })
    // Forward SKV's diagnostic headers: WWW-Authenticate carries OAuth's
    // machine-readable failure reason (the instance's insufficient_scope →
    // MISSING_SCOPE classification depends on it), and the x-skv-*/x-amzn-*/
    // x-api-* families are the only signal on body-less gateway rejections.
    // Nothing secret rides in them; stripping them blinded the instance's
    // 401 classifier (skeptic finding on PR6b-2).
    const headers: Record<string, string> = { 'Content-Type': res.headers.get('content-type') ?? 'application/json' }
    res.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (lk === 'www-authenticate' || lk.startsWith('x-skv-') || lk.startsWith('x-amzn-') || lk.startsWith('x-api-')) {
        headers[k] = v
      }
    })
    return new NextResponse(text, { status: res.status, headers })
  } finally {
    clearTimeout(timeout)
  }
}

export const GET = withConnectorAuth('connect.skv', handle)
export const POST = withConnectorAuth('connect.skv', handle)
export const PUT = withConnectorAuth('connect.skv', handle)
export const PATCH = withConnectorAuth('connect.skv', handle)
export const DELETE = withConnectorAuth('connect.skv', handle)
