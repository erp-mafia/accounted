import { NextResponse } from 'next/server'
import { decryptAuthCode, verifyPkce, hashAuthCode } from '@/lib/auth/oauth-codes'
import {
  generateApiKey,
  generateRefreshToken,
  hashRefreshToken,
  createServiceClientNoCookies,
  validateScopes,
  DEFAULT_OAUTH_SCOPES,
  type ApiKeyScope,
} from '@/lib/auth/api-keys'
import { requireCompanyId } from '@/lib/company/context'

const ACCESS_TOKEN_TTL_SECONDS = 3600

// Grace window (seconds) during which a just-superseded access token and refresh
// token stay valid after a rotation. Lets a client that cannot reliably persist
// the rotated refresh token, or that fires concurrent refreshes: recover via
// idempotent replay instead of being forced into a re-auth loop (issue #710).
// Reuse of a previous refresh token AFTER this window revokes the grant.
const REFRESH_GRACE_SECONDS = 120

/**
 * OAuth 2.0 Token Endpoint.
 *
 * Supports two grant types:
 *   - authorization_code: exchange a PKCE-protected auth code for a fresh
 *     api_key (access_token) plus a refresh_token.
 *   - refresh_token: rotate the refresh_token and return the same api_key
 *     with a fresh expires_in. The api_key itself does not expire
 *     server-side; expires_in is a hint so clients refresh on a cadence.
 */
export async function POST(request: Request) {
  let params: URLSearchParams

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text()
    params = new URLSearchParams(text)
  } else if (contentType.includes('application/json')) {
    const json = await request.json()
    params = new URLSearchParams(json as Record<string, string>)
  } else {
    return NextResponse.json({ error: 'unsupported_content_type' }, { status: 400 })
  }

  const grantType = params.get('grant_type')

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(params)
  }

  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(params)
  }

  return NextResponse.json(
    {
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token are supported',
    },
    { status: 400 }
  )
}

async function handleAuthorizationCodeGrant(params: URLSearchParams) {
  const code = params.get('code')
  const codeVerifier = params.get('code_verifier')
  const redirectUri = params.get('redirect_uri')

  if (!code) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing code parameter' },
      { status: 400 }
    )
  }

  const payload = decryptAuthCode(code)
  if (!payload) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' },
      { status: 400 }
    )
  }

  if (redirectUri && redirectUri !== payload.redirectUri) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'redirect_uri mismatch' },
      { status: 400 }
    )
  }

  if (!codeVerifier) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'code_verifier is required' },
      { status: 400 }
    )
  }

  if (!verifyPkce(codeVerifier, payload.codeChallenge)) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'PKCE verification failed' },
      { status: 400 }
    )
  }

  const codeHash = hashAuthCode(code)
  const supabase = createServiceClientNoCookies()

  const { error: replayError } = await supabase
    .from('oauth_used_codes')
    .insert({ code_hash: codeHash })

  if (replayError) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Authorization code already used' },
      { status: 400 }
    )
  }

  // Clean up expired codes (non-blocking, best-effort)
  supabase
    .from('oauth_used_codes')
    .delete()
    .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .then(() => {})

  const companyId = await requireCompanyId(supabase, payload.userId)

  const { key, hash, prefix } = generateApiKey()
  const refresh = generateRefreshToken()

  // Use the scopes the user consented to during /authorize. Re-validate
  // every value against API_KEY_SCOPES even though /authorize already did:
  // the auth code is AEAD-encrypted but we treat the boundary as
  // hostile by default (V9.2.1, defense-in-depth).
  let grantedScopes: ApiKeyScope[]
  if (payload.scopes && Array.isArray(payload.scopes) && payload.scopes.length > 0) {
    const revalidated = validateScopes(payload.scopes)
    if (!revalidated) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Authorization code carried no valid scopes' },
        { status: 400 }
      )
    }
    grantedScopes = revalidated
  } else {
    // Code minted with no scope (Claude's existing flow). Fall back to the
    // read-only OAuth defaults: destructive scopes must be requested
    // explicitly (GDPR Art. 25(2)).
    grantedScopes = DEFAULT_OAUTH_SCOPES
  }

  const { error: insertError } = await supabase
    .from('api_keys')
    .insert({
      user_id: payload.userId,
      company_id: companyId,
      key_hash: hash,
      key_prefix: prefix,
      name: 'MCP-klient (OAuth)',
      scopes: grantedScopes,
      refresh_token_hash: refresh.hash,
    })

  if (insertError) {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to create API key' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    access_token: key,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: grantedScopes.join(' '),
  })
}

async function handleRefreshTokenGrant(params: URLSearchParams) {
  const refreshToken = params.get('refresh_token')
  if (!refreshToken) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'refresh_token is required' },
      { status: 400 }
    )
  }

  const supabase = createServiceClientNoCookies()
  const presentedHash = hashRefreshToken(refreshToken)

  // Pre-generate the candidate credentials; the RPC decides whether to use them
  // (rotate / idempotent replay) or ignore them (reuse / revoked / invalid).
  // Doing lookup + rotate + demote in ONE SECURITY DEFINER RPC closes the
  // TOCTOU gap the old SELECT-then-CAS had, and lets a just-superseded refresh
  // token stay valid for a grace window so a client that cannot persist the
  // rotated token, or fires concurrent refreshes: recovers instead of being
  // forced into a re-auth loop (issue #710). Reuse AFTER the grace window
  // revokes the grant (RFC 9700 §4.14.2 reuse detection).
  const rotated = generateRefreshToken()
  const { key: newKey, hash: newKeyHash, prefix: newKeyPrefix } = generateApiKey()

  const { data, error } = await supabase.rpc('rotate_mcp_refresh_token', {
    p_presented_hash: presentedHash,
    p_new_refresh_hash: rotated.hash,
    p_new_key_hash: newKeyHash,
    p_new_key_prefix: newKeyPrefix,
    p_grace_seconds: REFRESH_GRACE_SECONDS,
  })

  if (error) {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to rotate refresh token' },
      { status: 500 }
    )
  }

  const result = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; scopes: string[] | null }
    | undefined
  const outcome = result?.outcome

  // 'rotated' (normal) and 'replayed' (idempotent in-grace retry/concurrent)
  // both succeed and return the freshly minted pair. Everything else maps to
  // invalid_grant; for 'reuse_revoked' the grant was already revoked in the RPC.
  if (outcome !== 'rotated' && outcome !== 'replayed') {
    return NextResponse.json(
      {
        error: 'invalid_grant',
        error_description:
          outcome === 'revoked' ? 'Refresh token revoked' : 'Invalid or expired refresh token',
      },
      { status: 400 }
    )
  }

  // Carry the granular scopes the key was minted with (read-only OAuth defaults
  // for legacy keys with null scopes) so clients don't re-authorize on refresh.
  const persistedScopes = validateScopes(result?.scopes ?? null) ?? DEFAULT_OAUTH_SCOPES

  return NextResponse.json({
    access_token: newKey,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: rotated.token,
    scope: persistedScopes.join(' '),
  })
}
