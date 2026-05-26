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
  // every value against API_KEY_SCOPES even though /authorize already did
  // — the auth code is AEAD-encrypted but we treat the boundary as
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
    // read-only OAuth defaults — destructive scopes must be requested
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

  // Look up the api_key row by refresh_token_hash. The hash is unique among
  // non-null values, so there's at most one match. We pull `scopes` so the
  // rotated token response advertises the same granular grant the key
  // already carries (otherwise OAuth 2.1 clients would re-authorize on
  // every refresh).
  const { data: row, error: lookupError } = await supabase
    .from('api_keys')
    .select('id, revoked_at, scopes')
    .eq('refresh_token_hash', presentedHash)
    .maybeSingle()

  if (lookupError) {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to look up refresh token' },
      { status: 500 }
    )
  }

  if (!row) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid refresh token' },
      { status: 400 }
    )
  }

  if (row.revoked_at) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Refresh token revoked' },
      { status: 400 }
    )
  }

  // Rotate both tokens atomically. OAuth 2.1 §6.1 recommends rotating the
  // refresh token; we also rotate the api_key because key_hash is one-way
  // and we cannot recover the original plaintext to return to the client.
  // The .eq('refresh_token_hash', presentedHash) guard makes this a CAS:
  // a concurrent refresh with the same token will affect 0 rows.
  const rotated = generateRefreshToken()
  const { key: newKey, hash: newKeyHash, prefix: newKeyPrefix } = generateApiKey()

  const { data: updated, error: updateError } = await supabase
    .from('api_keys')
    .update({
      refresh_token_hash: rotated.hash,
      key_hash: newKeyHash,
      key_prefix: newKeyPrefix,
    })
    .eq('id', row.id)
    .eq('refresh_token_hash', presentedHash)
    .select('id')

  if (updateError) {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to rotate refresh token' },
      { status: 500 }
    )
  }

  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Refresh token already used' },
      { status: 400 }
    )
  }

  // Return the granular scopes the key was originally minted with. Falling
  // back to the read-only OAuth defaults preserves the pre-scope-plumbing
  // behaviour for legacy keys whose scopes column is null.
  const persistedScopes = validateScopes(row.scopes) ?? DEFAULT_OAUTH_SCOPES

  return NextResponse.json({
    access_token: newKey,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: rotated.token,
    scope: persistedScopes.join(' '),
  })
}
