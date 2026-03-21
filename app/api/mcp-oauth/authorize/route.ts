import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createAuthCode } from '@/lib/auth/oauth-codes'

/**
 * OAuth 2.0 Authorization Endpoint.
 *
 * GET  → show consent page (or redirect to login)
 * POST → process consent, create auth code, redirect to callback
 *
 * The API key is NOT created here — it's created in the token endpoint
 * after PKCE verification, preventing orphaned keys on abandoned flows.
 */

// Known Claude callback URLs — reject all others to prevent open redirect
const ALLOWED_REDIRECT_PATTERNS = [
  /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/,
  /^https:\/\/claude\.com\/api\/mcp\/auth_callback$/,
  /^http:\/\/localhost(:\d+)?\//, // Local development
  /^http:\/\/127\.0\.0\.1(:\d+)?\//, // Local development
]

function isAllowedRedirectUri(uri: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some((pattern) => pattern.test(uri))
}

function buildLoginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const next = `${url.pathname}${url.search}`
  return NextResponse.redirect(
    new URL(`/login?next=${encodeURIComponent(next)}`, url.origin)
  )
}

function errorRedirect(redirectUri: string, state: string | null, error: string, desc: string): Response {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', desc)
  if (state) url.searchParams.set('state', state)
  return NextResponse.redirect(url.toString())
}

/**
 * GET /api/mcp-oauth/authorize — show consent page
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge')
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256'
  const responseType = url.searchParams.get('response_type')

  if (responseType !== 'code') {
    return NextResponse.json(
      { error: 'unsupported_response_type' },
      { status: 400 }
    )
  }

  if (!redirectUri) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is required' },
      { status: 400 }
    )
  }

  // Validate redirect_uri against allowlist (prevents open redirect)
  if (!isAllowedRedirectUri(redirectUri)) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  if (codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' },
      { status: 400 }
    )
  }

  // Check if user is logged in
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Get company name for the consent page
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('user_id', user.id)
    .single()

  const companyName = settings?.company_name || user.email

  // Render consent page
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="translate" content="no">
  <title>Anslut MCP-klient — gnubok</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
    .card { background: white; border-radius: 12px; border: 1px solid #e5e5e5; padding: 2rem; max-width: 400px; width: 100%; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #666; line-height: 1.5; margin-bottom: 1rem; }
    .account { font-size: 0.875rem; color: #111; font-weight: 500; background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .permissions { font-size: 0.8125rem; color: #444; margin-bottom: 1.5rem; }
    .permissions li { margin-bottom: 0.25rem; }
    .actions { display: flex; gap: 0.75rem; }
    button { flex: 1; padding: 0.625rem 1rem; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: 1px solid #e5e5e5; }
    .allow { background: #111; color: white; border-color: #111; }
    .allow:hover { background: #333; }
    .deny { background: white; color: #111; }
    .deny:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Anslut MCP-klient</h1>
    <p>En extern applikation vill ansluta till ditt gnubok-konto.</p>
    <div class="account">${escapeHtml(companyName)}</div>
    <ul class="permissions">
      <li>Visa och kategorisera transaktioner</li>
      <li>Skapa och visa fakturor</li>
      <li>Visa kunder och rapporter</li>
      <li>Skapa verifikationer</li>
    </ul>
    <div class="actions">
      <form method="POST" action="${url.pathname}${url.search}" style="flex:1;display:flex;">
        <input type="hidden" name="consent" value="deny">
        <button type="submit" class="deny" style="width:100%;">Neka</button>
      </form>
      <form method="POST" action="${url.pathname}${url.search}" style="flex:1;display:flex;">
        <input type="hidden" name="consent" value="allow">
        <button type="submit" class="allow" style="width:100%;">Tillåt</button>
      </form>
    </div>
  </div>
</body>
</html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

/**
 * POST /api/mcp-oauth/authorize — process consent, issue auth code
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge') || ''

  if (!redirectUri) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  if (!isAllowedRedirectUri(redirectUri)) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  // Check auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Parse form body
  const formData = await request.formData()
  const consent = formData.get('consent')

  if (consent !== 'allow') {
    return errorRedirect(redirectUri, state, 'access_denied', 'User denied the request')
  }

  // Create auth code with userId (NO API key — that's created at /token after PKCE)
  const code = createAuthCode({
    userId: user.id,
    codeChallenge,
    redirectUri,
  })

  // Redirect to callback with the code
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', code)
  if (state) callbackUrl.searchParams.set('state', state)

  return NextResponse.redirect(callbackUrl.toString())
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
