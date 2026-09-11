import { NextResponse } from 'next/server'
import crypto from 'crypto'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolveOAuthOrigin } from '@/lib/auth/oauth-flows'
import { isZettleConfigured } from './lib/credentials'
import { buildAuthorizeUrl, disconnectApplication, refreshAccessToken } from './lib/oauth'
import { refreshTokenOf } from './lib/credentials'
import { syncZettlePurchases } from './lib/order-sync'
import { parseZettleOrganizationName } from './lib/organization-name'
import type { ZettleConnection, ZettleStatusResponse } from './types'

const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_DISCONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_SYNC = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_RENAME = { maxRequests: 20, windowMs: 60_000 }

const NOT_CONFIGURED_MESSAGE =
  'Zettle-integrationen är inte konfigurerad på den här installationen.'

const STATUS_COLUMNS =
  'id, status, organization_uuid, organization_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at'

type AuthedContext = {
  supabase: ExtensionContext['supabase']
  userId: string
  isAnonymous: boolean
  companyId: string
}

async function requireUserAndCompany(
  ctx: ExtensionContext | undefined,
): Promise<AuthedContext | NextResponse> {
  const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!ctx?.companyId) {
    return NextResponse.json({ error: 'Company context required' }, { status: 400 })
  }
  return {
    supabase,
    userId: user.id,
    isAnonymous: Boolean(user.is_anonymous),
    companyId: ctx.companyId,
  }
}

async function guardConnectPreconditions(auth: AuthedContext): Promise<NextResponse | null> {
  if (auth.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(auth.supabase, auth.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(auth.supabase, auth.companyId, CAPABILITY.zettle_sync)
}

export const zettleApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/status',
    handler: async (_request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const { data: rows } = await auth.supabase
        .from('zettle_connections')
        .select(STATUS_COLUMNS)
        .eq('company_id', auth.companyId)
        .order('created_at', { ascending: false })
        .limit(10)

      const connection = rows?.find((r) => r.status === 'active') ?? rows?.[0] ?? null
      const payload: ZettleStatusResponse = {
        configured: isZettleConfigured(),
        connection,
      }
      return NextResponse.json(payload)
    },
  },
  {
    method: 'POST',
    path: '/connect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const blocked = await guardConnectPreconditions(auth)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'zettle:connect',
        identifier: auth.userId,
        ...RATE_LIMIT_CONNECT,
      })
      if (!rl.ok) return rl.response!

      if (!isZettleConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const { data: existing } = await auth.supabase
        .from('zettle_connections')
        .select('id')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
      if (existing && existing.length > 0) {
        return NextResponse.json(
          { error: 'Företaget har redan ett anslutet Zettle-konto. Koppla från det först.' },
          { status: 409 },
        )
      }

      // Drop stale pending rows for this company so a retry starts clean.
      await auth.supabase
        .from('zettle_connections')
        .update({ status: 'error', oauth_state: null, error_message: 'Ersatt av ny anslutning' })
        .eq('company_id', auth.companyId)
        .eq('status', 'pending')

      const oauthState = crypto.randomUUID()
      // Remember the validated origin (app or brand domain) the merchant
      // started on: Zettle redirects to the one registered callback URL, so
      // the callback cannot see which brand the browser came from.
      const returnOrigin = await resolveOAuthOrigin(request)
      const { data: created, error: insertError } = await auth.supabase
        .from('zettle_connections')
        .insert({
          company_id: auth.companyId,
          user_id: auth.userId,
          status: 'pending',
          oauth_state: oauthState,
          return_origin: returnOrigin,
        })
        .select('id')
        .single()

      if (insertError || !created) {
        log.error('[zettle] Failed to create pending connection', {
          message: insertError?.message,
          code: insertError?.code,
          companyId: auth.companyId,
        })
        return NextResponse.json(
          { error: 'Kunde inte starta anslutningen. Försök igen.' },
          { status: 500 },
        )
      }

      try {
        return NextResponse.json({ url: buildAuthorizeUrl(oauthState) })
      } catch (err) {
        log.error('[zettle] Failed to build authorize URL', {
          message: err instanceof Error ? err.message : String(err),
        })
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }
    },
  },
  {
    method: 'POST',
    path: '/sync',
    handler: async (_request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(
        auth.supabase,
        auth.companyId,
        CAPABILITY.zettle_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'zettle:sync',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      const { data: connection } = await auth.supabase
        .from('zettle_connections')
        .select('*')
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
        .maybeSingle()

      if (!connection) {
        return NextResponse.json({ error: 'Inget anslutet Zettle-konto.' }, { status: 404 })
      }

      try {
        const serviceClient = createServiceClientNoCookies()
        const summary = await syncZettlePurchases(
          serviceClient,
          connection as ZettleConnection,
          undefined,
          Date.now() + 240_000,
        )
        if (summary.locked) {
          return NextResponse.json(
            { error: 'En synkronisering pågår redan. Försök igen om en stund.' },
            { status: 409 },
          )
        }
        return NextResponse.json({ success: true, transactions: summary })
      } catch (error) {
        log.error('[zettle] Manual sync failed', {
          message: error instanceof Error ? error.message : String(error),
          connection_id: connection.id,
        })
        return NextResponse.json(
          { error: 'Synkroniseringen misslyckades. Försök igen.' },
          { status: 502 },
        )
      }
    },
  },
  {
    method: 'POST',
    path: '/transaction-sync',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(
        auth.supabase,
        auth.companyId,
        CAPABILITY.zettle_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'zettle:transaction-sync-toggle',
        identifier: auth.userId,
        ...RATE_LIMIT_SYNC,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { enabled?: unknown }
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'enabled (boolean) krävs.' }, { status: 400 })
      }

      const { data: updated, error: updateError } = await auth.supabase
        .from('zettle_connections')
        .update({ transaction_sync_enabled: body.enabled })
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
        .select('id')

      if (updateError) {
        return NextResponse.json(
          { error: 'Kunde inte spara inställningen. Försök igen.' },
          { status: 500 },
        )
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: 'Inget anslutet Zettle-konto.' }, { status: 404 })
      }
      return NextResponse.json({ success: true, enabled: body.enabled })
    },
  },
  {
    method: 'POST',
    path: '/organization-name',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const capabilityBlocked = await requireCapability(
        auth.supabase,
        auth.companyId,
        CAPABILITY.zettle_sync,
      )
      if (capabilityBlocked) return capabilityBlocked

      const rl = await checkRateLimit({
        prefix: 'zettle:organization-name',
        identifier: auth.userId,
        ...RATE_LIMIT_RENAME,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as {
        organization_name?: unknown
      }
      const parsed = parseZettleOrganizationName(body.organization_name)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }

      const { data: updated, error: updateError } = await auth.supabase
        .from('zettle_connections')
        .update({ organization_name: parsed.name })
        .eq('company_id', auth.companyId)
        .eq('status', 'active')
        .select('id')

      if (updateError) {
        return NextResponse.json(
          { error: 'Kunde inte spara butiksnamnet. Försök igen.' },
          { status: 500 },
        )
      }
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: 'Inget anslutet Zettle-konto.' }, { status: 404 })
      }

      // Orders.Butik shows store_label || store_scope; keep existing rows in
      // sync so a rename does not leave the UUID visible until the next feed.
      const connectionIds = updated.map((row) => row.id)
      const { error: backfillError } = await auth.supabase
        .from('webshop_orders')
        .update({ store_label: parsed.name })
        .eq('company_id', auth.companyId)
        .eq('platform', 'zettle')
        .in('connection_id', connectionIds)

      if (backfillError) {
        return NextResponse.json(
          {
            success: true,
            organization_name: parsed.name,
            warning: 'Namnet sparades, men befintliga ordrar kunde inte uppdateras.',
          },
          { status: 200 },
        )
      }

      return NextResponse.json({ success: true, organization_name: parsed.name })
    },
  },
  {
    method: 'DELETE',
    path: '/disconnect',
    handler: async (request: Request, ctx?: ExtensionContext) => {
      const log = ctx?.log ?? console
      const auth = await requireUserAndCompany(ctx)
      if (auth instanceof NextResponse) return auth

      const rl = await checkRateLimit({
        prefix: 'zettle:disconnect',
        identifier: auth.userId,
        ...RATE_LIMIT_DISCONNECT,
      })
      if (!rl.ok) return rl.response!

      const body = (await request.json().catch(() => ({}))) as { connection_id?: string }
      const base = auth.supabase
        .from('zettle_connections')
        .select('id, status, organization_uuid, refresh_token_encrypted')
        .eq('company_id', auth.companyId)
      const query = body.connection_id
        ? base.eq('id', body.connection_id).limit(1)
        : base.neq('status', 'revoked').order('created_at', { ascending: false }).limit(1)
      const { data: rows, error: findError } = await query
      const connection = rows?.[0]

      if (findError || !connection) {
        return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
      }

      if (connection.refresh_token_encrypted) {
        try {
          const tokens = await refreshAccessToken(refreshTokenOf(connection))
          await disconnectApplication(tokens.access_token)
        } catch (err) {
          log.warn('[zettle] Remote disconnect failed; continuing local revoke', {
            message: err instanceof Error ? err.message : String(err),
            connection_id: connection.id,
          })
        }
      }

      const { error: updateError } = await auth.supabase
        .from('zettle_connections')
        .update({
          status: 'revoked',
          refresh_token_encrypted: null,
          oauth_state: null,
          disconnected_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
        .eq('company_id', auth.companyId)

      if (updateError) {
        log.error('[zettle] Failed to mark connection revoked', {
          message: updateError.message,
          connection_id: connection.id,
        })
        return NextResponse.json(
          { error: 'Kunde inte koppla från. Försök igen.' },
          { status: 500 },
        )
      }

      if (ctx?.emit) {
        try {
          await ctx.emit({
            type: 'zettle.disconnected',
            payload: {
              connectionId: connection.id,
              organizationUuid: connection.organization_uuid ?? null,
              reason: 'user',
              userId: auth.userId,
              companyId: auth.companyId,
            },
          })
        } catch {
          // Audit event failure must not block disconnect.
        }
      }

      return NextResponse.json({ success: true })
    },
  },
]
