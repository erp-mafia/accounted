import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withConnectorAuth, type ConnectorContext } from '@/lib/connect/hosted/with-connector-auth'
import { buildSkvAuthorizeUrl, skvDefaultScopes } from '@/lib/connect/upstreams/skatteverket-oauth'
import { reserveUpstream } from '@/lib/connect/hosted/upstream-budget'
import { countHeldConnections, createPendingConnection, deletePendingConnectionById } from '@/lib/connect/hosted/ledger'
import { signConnectorState } from '@/lib/connect/hosted/state'

/**
 * POST /api/connect/skv/oauth/authorize-url
 *
 * The instance asks the connector broker to start a Skatteverket BankID
 * consent for one company. The broker builds the authorize URL against
 * Arcim's registered SKV client, using OUR registered redirect_uri, with a
 * signed connector state that carries the instance's own return URL; the SKV
 * extension callback (on the hosted host) detects that state and bounces the
 * browser back to the instance with the code. The instance keeps its own PKCE
 * verifier and later calls /oauth/token with the code.
 *
 * Tokens never touch us: the token exchange returns them to the instance,
 * which stores them (encrypted) in its own database.
 */

const Schema = z.object({
  company_ref: z.string().min(1).max(200),
  return_url: z.string().url().max(512),
  state: z.string().min(1).max(200),
  code_challenge: z.string().min(16).max(256),
  scope: z.string().max(400).optional(),
})

function requireScope(ctx: ConnectorContext): NextResponse | null {
  if (ctx.key.scopes.includes('skatteverket')) return null
  return NextResponse.json({ error: 'This connector key does not include Skatteverket', code: 'CONNECTOR_SCOPE_MISSING' }, { status: 403 })
}

function hostedRedirectUri(): string {
  const base = (process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}/api/extensions/ext/skatteverket/callback`
}

function isOnInstance(url: string, instanceUrl: string | null): boolean {
  if (!instanceUrl) return false
  try {
    return new URL(url).origin === new URL(instanceUrl).origin
  } catch {
    return false
  }
}

export const POST = withConnectorAuth('connect.skv', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  const parsed = await validateBody(request, Schema, { log: ctx.log, operation: 'connect.skv.authorize-url' })
  if (!parsed.success) return parsed.response
  const { company_ref: cref, return_url, state, code_challenge, scope } = parsed.data

  if (!isOnInstance(return_url, ctx.key.instanceUrl)) {
    return NextResponse.json({ error: 'return_url must be on the connector key\'s instance', code: 'CONNECTOR_REDIRECT_INVALID' }, { status: 400 })
  }
  // Quota with a reservation re-count (same TOCTOU fix as the bank /auth):
  // pre-count fast-rejects, the pending row reserves, the post-insert
  // re-count rolls the own row back when concurrent authorizes overshoot.
  const quotaExceeded = () =>
    NextResponse.json(
      { error: 'Skatteverket connection quota reached for this company', code: 'CONNECTOR_QUOTA_EXCEEDED', limit: ctx.key.limits.skv_connections_per_company },
      { status: 403 },
    )
  const held = await countHeldConnections(ctx.supabase, ctx.key.id, 'skatteverket', cref)
  if (held >= ctx.key.limits.skv_connections_per_company) return quotaExceeded()
  const budget = await reserveUpstream(ctx.supabase, 'skatteverket')
  if (!budget.ok) {
    return NextResponse.json({ error: 'Skatteverket connector is busy', code: 'CONNECTOR_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(budget.retryAfterSec) } })
  }

  const signedState = signConnectorState({ kid: ctx.key.id, svc: 'skv', ret: return_url, st: state, cref })
  const redirectUri = hostedRedirectUri()
  const pendingId = await createPendingConnection(ctx.supabase, { keyId: ctx.key.id, service: 'skatteverket', companyRef: cref, provider: 'skatteverket', pendingState: signedState })
  const heldAfter = await countHeldConnections(ctx.supabase, ctx.key.id, 'skatteverket', cref)
  if (heldAfter > ctx.key.limits.skv_connections_per_company) {
    await deletePendingConnectionById(ctx.supabase, pendingId)
    return quotaExceeded()
  }

  const authorizeUrl = buildSkvAuthorizeUrl(redirectUri, signedState, { scope: scope || skvDefaultScopes(), codeChallenge: code_challenge })
  return NextResponse.json({ data: { authorize_url: authorizeUrl, redirect_uri: redirectUri, connector_state: signedState } })
})
