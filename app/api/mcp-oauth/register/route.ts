import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { isAllowedRedirectUri } from '@/lib/auth/oauth-allowlist'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { truncateIp } from '@/lib/api/v1/with-api-v1'

/**
 * RFC 7591: Dynamic Client Registration.
 *
 * Claude Desktop and self-hosted MCP clients register themselves before
 * starting the auth flow. The redirect URIs they declare are validated
 * against built-in patterns (Claude/localhost) and the user-managed
 * oauth_client_registrations table (self-hosted custom apps).
 *
 * Security model:
 *  - Anonymous by design (RFC 7591 §3 allows it); the endpoint does NOT
 *    write to oauth_client_registrations: only owner/admin users can
 *    insert via /api/settings/oauth-clients. This endpoint just echoes
 *    a client_id back to callers whose redirect_uris are already on the
 *    allowlist.
 *  - Per-/24 sliding-window rate-limit prevents the endpoint being used
 *    as a high-rate oracle for enumerating registered URIs.
 *  - Error responses are uniform across "built-in", "DB-registered", and
 *    "disallowed" so an attacker cannot distinguish between them.
 */

const REGISTER_RATE_LIMIT = {
  // 10 attempts per minute per /24: enough headroom for a developer
  // iterating on a custom MCP client, low enough to make enumeration
  // attacks impractical.
  maxRequests: 10,
  windowMs: 60 * 1000,
}

export async function POST(request: Request) {
  // ── IP-based rate limit ─────────────────────────────────────
  const fwd = request.headers.get('x-forwarded-for')
  const rawIp = fwd ? fwd.split(',')[0]?.trim() : request.headers.get('x-real-ip') ?? undefined
  const ipIdentifier = truncateIp(rawIp || undefined) ?? 'unknown'
  const rl = await checkRateLimit({
    prefix: 'mcp-oauth:register',
    identifier: ipIdentifier,
    ...REGISTER_RATE_LIMIT,
  })
  if (!rl.ok) return rl.response!

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  // Service-role client used for the allowlist lookup. Building it once
  // keeps the per-URI loop from re-instantiating the client and surfaces
  // the trust boundary at the callsite (SOC 2 CC6.1).
  let allowlistClient: ReturnType<typeof createServiceClientNoCookies> | undefined
  try {
    allowlistClient = createServiceClientNoCookies()
  } catch {
    // Env vars missing: built-in patterns still resolve, DB-backed
    // registrations will all return false (fail closed).
    allowlistClient = undefined
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !(await isAllowedRedirectUri(uri, allowlistClient))) {
      // Single error shape regardless of whether the URI is malformed,
      // unknown, or revoked: prevents the endpoint being used as an
      // enumeration oracle for the user-managed allowlist (CC6.6).
      return NextResponse.json(
        { error: 'invalid_redirect_uri', error_description: 'Redirect URI not allowed' },
        { status: 400 }
      )
    }
  }

  const clientId = crypto.randomUUID()

  return NextResponse.json({
    client_id: clientId,
    client_name: (body.client_name as string) || 'MCP Client',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, { status: 201 })
}
