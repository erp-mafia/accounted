import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withConnectorAuth, type ConnectorContext } from '@/lib/connect/hosted/with-connector-auth'
import { exchangeSkvCode, refreshSkvToken, type SkvTokenResponse } from '@/lib/connect/upstreams/skatteverket-oauth'
import { reserveUpstream } from '@/lib/connect/hosted/upstream-budget'
import { activateByPendingState, hashHandle } from '@/lib/connect/hosted/ledger'

/**
 * POST /api/connect/skv/oauth/token
 *
 * The broker exchanges an authorization code (or refreshes) with Arcim's SKV
 * client secret and returns the tokens to the instance, which stores them.
 * The ledger records only the SHA-256 of the access token (and refresh token),
 * so later data calls can prove the presenting bearer belongs to this key.
 *
 *   grant_type = authorization_code : { code, redirect_uri, code_verifier?, connector_state }
 *   grant_type = refresh_token      : { refresh_token }
 */

const AuthCodeSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1).max(4096),
  redirect_uri: z.string().url().max(512),
  code_verifier: z.string().min(16).max(256).optional(),
  connector_state: z.string().min(1).max(2048),
})
const RefreshSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1).max(4096),
})
const Schema = z.discriminatedUnion('grant_type', [AuthCodeSchema, RefreshSchema])

function requireScope(ctx: ConnectorContext): NextResponse | null {
  if (ctx.key.scopes.includes('skatteverket')) return null
  return NextResponse.json({ error: 'This connector key does not include Skatteverket', code: 'CONNECTOR_SCOPE_MISSING' }, { status: 403 })
}

function tokenResponse(t: SkvTokenResponse): NextResponse {
  return NextResponse.json({
    data: { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in, scope: t.scope },
  })
}

export const POST = withConnectorAuth('connect.skv', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  const parsed = await validateBody(request, Schema, { log: ctx.log, operation: 'connect.skv.token' })
  if (!parsed.success) return parsed.response

  const budget = await reserveUpstream(ctx.supabase, 'skatteverket')
  if (!budget.ok) {
    return NextResponse.json({ error: 'Skatteverket connector is busy', code: 'CONNECTOR_RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': String(budget.retryAfterSec) } })
  }

  try {
    if (parsed.data.grant_type === 'authorization_code') {
      const { code, redirect_uri, code_verifier, connector_state } = parsed.data
      const tokens = await exchangeSkvCode(code, redirect_uri, code_verifier)
      await activateByPendingState(ctx.supabase, { keyId: ctx.key.id, pendingState: connector_state, handle: tokens.access_token })
      if (tokens.refresh_token) {
        await ctx.supabase
          .from('connector_connections')
          .update({ refresh_hash: hashHandle(tokens.refresh_token) })
          .eq('connector_key_id', ctx.key.id)
          .eq('handle_hash', hashHandle(tokens.access_token))
      }
      return tokenResponse(tokens)
    }

    // refresh: rotate the ledger's handle + refresh hashes to the new pair.
    // Two literal payloads (no runtime-built object) so the no-phantom-columns
    // scanner can resolve the columns.
    const { refresh_token } = parsed.data
    const tokens = await refreshSkvToken(refresh_token)
    const newHandleHash = tokens.access_token ? hashHandle(tokens.access_token) : null
    const lastUsedAt = new Date().toISOString()
    const oldRefreshHash = hashHandle(refresh_token)
    if (tokens.refresh_token) {
      await ctx.supabase
        .from('connector_connections')
        .update({ handle_hash: newHandleHash, last_used_at: lastUsedAt, refresh_hash: hashHandle(tokens.refresh_token) })
        .eq('connector_key_id', ctx.key.id)
        .eq('service', 'skatteverket')
        .eq('refresh_hash', oldRefreshHash)
        .eq('status', 'active')
    } else {
      await ctx.supabase
        .from('connector_connections')
        .update({ handle_hash: newHandleHash, last_used_at: lastUsedAt })
        .eq('connector_key_id', ctx.key.id)
        .eq('service', 'skatteverket')
        .eq('refresh_hash', oldRefreshHash)
        .eq('status', 'active')
    }
    return tokenResponse(tokens)
  } catch (err) {
    ctx.log.warn('skv token exchange failed', { err: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Skatteverket token exchange failed', code: 'CONNECTOR_SKV_TOKEN_FAILED' }, { status: 502 })
  }
})
