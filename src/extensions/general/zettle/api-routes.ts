import { NextResponse } from 'next/server'
import crypto from 'crypto'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { guardSandbox, sandboxBlockedResponse } from '@/lib/sandbox/guard'
import { resolveOAuthOrigin } from '@/lib/auth/oauth-flows'
import { feedConnectorRoutes, type FeedConnectorSpec } from '@/lib/feed-sync/connector-routes'
import { DEFAULT_PAYMENT_ACCOUNT } from '@/lib/webshop-orders/booking-lines'
import { isZettleConfigured, refreshTokenOf } from './lib/credentials'
import { buildAuthorizeUrl, disconnectApplication, refreshAccessToken } from './lib/oauth'
import { syncZettlePurchases, type ZettleSyncSummary } from './lib/order-sync'
import { parseZettleOrganizationName } from './lib/organization-name'
import { MAX_BACKFILL_YEARS } from './types'
import type { ZettleConnection } from './types'

const RATE_LIMIT_CONNECT = { maxRequests: 10, windowMs: 60_000 }
const RATE_LIMIT_RENAME = { maxRequests: 20, windowMs: 60_000 }

const NOT_CONFIGURED_MESSAGE =
  'Zettle-integrationen är inte konfigurerad på den här installationen.'

/**
 * Status, sync, backfill, the nightly toggle and disconnect: the shared feed
 * routes (lib/feed-sync/connector-routes). Disconnect revokes the app at
 * Zettle first, which needs the encrypted refresh token: the lookup runs on
 * the service role.
 */
export const zettleFeed: FeedConnectorSpec<ZettleConnection, ZettleSyncSummary> = {
  extensionId: 'zettle',
  table: 'zettle_connections',
  capability: CAPABILITY.zettle_sync,
  cursorColumn: 'last_order_synced_at',
  maxBackfillYears: MAX_BACKFILL_YEARS,
  // Orders book against the payment account, 1686 unless the store maps another.
  settlementAccounts: [DEFAULT_PAYMENT_ACCOUNT],
  notConnectedMessage: 'Inget anslutet Zettle-konto.',
  statusColumns:
    'id, status, organization_uuid, organization_name, currency, error_message, connected_at, transaction_sync_enabled, last_order_synced_at',
  isConfigured: isZettleConfigured,
  sync: (supabase, connection, deadlineMs) => syncZettlePurchases(supabase, connection, undefined, deadlineMs),
  disconnect: {
    columns: 'organization_uuid, refresh_token_encrypted',
    lookupWithServiceRole: true,
    revokeRemote: async (connection) => {
      if (!connection.refresh_token_encrypted) return
      const tokens = await refreshAccessToken(refreshTokenOf(connection as Pick<ZettleConnection, 'refresh_token_encrypted'>))
      await disconnectApplication(tokens.access_token)
    },
    clearColumns: ['refresh_token_encrypted', 'oauth_state'],
    eventIdentity: (connection) => ({ organizationUuid: (connection.organization_uuid as string | null) ?? null }),
  },
}

async function guardConnectPreconditions(ctx: ExtensionContext): Promise<NextResponse | null> {
  if (ctx.isAnonymous) return sandboxBlockedResponse()
  const sandboxBlocked = await guardSandbox(ctx.supabase, ctx.companyId)
  if (sandboxBlocked) return sandboxBlocked
  return requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.zettle_sync)
}

/**
 * POST /organization-name: the merchant names the store. Zettle's users/self
 * carries no name, so Accounted holds it in zettle_connections.organization_name
 * and copies it to webshop_orders.store_label (Butik on the Orders page).
 * One RPC renames the connection and backfills the orders in one transaction,
 * so two concurrent renames cannot leave the orders on an older name.
 */
async function handlePostOrganizationName(request: Request, ctx: ExtensionContext): Promise<NextResponse> {
  const blocked = await requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.zettle_sync)
  if (blocked) return blocked

  const rl = await checkRateLimit({
    prefix: 'zettle:organization-name',
    identifier: ctx.userId,
    ...RATE_LIMIT_RENAME,
  })
  if (!rl.ok) return rl.response!

  const body = (await request.json().catch(() => ({}))) as { organization_name?: unknown }
  const parsed = parseZettleOrganizationName(body.organization_name)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const { data: result, error: renameError } = await ctx.supabase.rpc('rename_zettle_store', {
    p_company_id: ctx.companyId,
    p_name: parsed.name,
  })
  if (renameError) {
    ctx.log.error('[zettle] Failed to rename the store', {
      message: renameError.message,
      code: renameError.code,
      companyId: ctx.companyId,
    })
    return NextResponse.json({ error: 'Kunde inte spara butiksnamnet. Försök igen.' }, { status: 500 })
  }

  const outcome = (result ?? {}) as { updated?: boolean; backfilled?: boolean }
  if (!outcome.updated) {
    return NextResponse.json({ error: zettleFeed.notConnectedMessage }, { status: 404 })
  }
  if (outcome.backfilled === false) {
    return NextResponse.json({
      success: true,
      organization_name: parsed.name,
      warning: 'Namnet sparades, men befintliga ordrar kunde inte uppdateras.',
    })
  }
  return NextResponse.json({ success: true, organization_name: parsed.name })
}

export const zettleApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'POST',
    path: '/connect',
    handler: async (request: Request, ctx: ExtensionContext) => {
      const log = ctx.log
      const blocked = await guardConnectPreconditions(ctx)
      if (blocked) return blocked

      const rl = await checkRateLimit({
        prefix: 'zettle:connect',
        identifier: ctx.userId,
        ...RATE_LIMIT_CONNECT,
      })
      if (!rl.ok) return rl.response!

      if (!isZettleConfigured()) {
        return NextResponse.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })
      }

      const { data: existing } = await ctx.supabase
        .from('zettle_connections')
        .select('id')
        .eq('company_id', ctx.companyId)
        .eq('status', 'active')
      if (existing && existing.length > 0) {
        return NextResponse.json(
          { error: 'Företaget har redan ett anslutet Zettle-konto. Koppla från det först.' },
          { status: 409 },
        )
      }

      // Drop stale pending rows for this company so a retry starts clean.
      await ctx.supabase
        .from('zettle_connections')
        .update({ status: 'error', oauth_state: null, error_message: 'Ersatt av ny anslutning' })
        .eq('company_id', ctx.companyId)
        .eq('status', 'pending')

      const oauthState = crypto.randomUUID()
      // Remember the validated origin (app or brand domain) the merchant
      // started on: Zettle redirects to the one registered callback URL, so
      // the callback cannot see which brand the browser came from.
      const returnOrigin = await resolveOAuthOrigin(request)
      const { data: created, error: insertError } = await ctx.supabase
        .from('zettle_connections')
        .insert({
          company_id: ctx.companyId,
          user_id: ctx.userId,
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
          companyId: ctx.companyId,
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
    path: '/organization-name',
    handler: handlePostOrganizationName,
  },
  ...feedConnectorRoutes(zettleFeed),
]
