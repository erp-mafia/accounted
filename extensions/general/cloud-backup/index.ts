import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import {
  createOAuthState,
  decryptToken,
  encryptToken,
  verifyOAuthState,
} from './lib/crypto'
import { performSync } from './lib/sync'
import { resolveCallbackOrigin } from './lib/callback-origin'
import { stockholmHourToUtcHour } from './lib/schedule'
import { CLOUD_PROVIDERS, providerFromRequest } from './lib/provider-registry'
import { googleDriveProvider } from './lib/google-provider'
import { dropboxProvider } from './lib/dropbox-provider'
import type { CloudStorageProvider } from './lib/cloud-provider'
import type {
  CloudBackupStatus,
  CloudConnection,
  CloudLastSync,
  CloudProviderStatus,
  CloudSchedule,
} from './types'

function jsonError(message: string, status = 500): Response {
  return NextResponse.json({ error: message }, { status })
}

const DEFAULT_SCHEDULE: CloudSchedule = {
  enabled: false,
  hour_utc: 3,
  hour_local: 5, // 05:00 Swedish time, DST-stable: low-traffic default
  last_auto_sync_at: null,
  last_auto_sync_status: null,
  last_auto_sync_error: null,
}

/**
 * Resolve the destination a request targets. An unknown `?provider=` value is
 * an error rather than a silent fallback: writing a company's backup to the
 * wrong destination because of a typo must never happen quietly.
 *
 * `requireConfigured` is for `/connect` alone, which cannot succeed without
 * OAuth credentials. Every other route stays open even when a deployment loses
 * its credentials: a user must always be able to disconnect an account or
 * switch off a schedule, and locking those behind an env var would trap them.
 */
function resolveProvider(
  request: Request,
  options: { requireConfigured?: boolean } = {}
): { provider: CloudStorageProvider } | { error: Response } {
  const provider = providerFromRequest(request)
  if (!provider) {
    return { error: jsonError('unknown_provider', 400) }
  }
  if (options.requireConfigured && !provider.isConfigured()) {
    return { error: jsonError('provider_not_configured', 400) }
  }
  return { provider }
}

async function readProviderStatus(
  ctx: ExtensionContext,
  provider: CloudStorageProvider
): Promise<CloudProviderStatus> {
  const connection = await ctx.settings.get<CloudConnection>(provider.keys.connection)
  const lastSync = await ctx.settings.get<CloudLastSync>(provider.keys.lastSync)
  const schedule = await ctx.settings.get<CloudSchedule>(provider.keys.schedule)
  return {
    provider: provider.id,
    configured: provider.isConfigured(),
    connected: !!connection,
    needs_reauth: connection?.status === 'needs_reauth',
    account_email: connection?.account_email ?? null,
    connected_at: connection?.connected_at ?? null,
    last_sync: lastSync ?? null,
    schedule: schedule ?? null,
  }
}

/**
 * Shared OAuth callback body. Each provider needs its own route because the
 * redirect URI is registered with the provider, but the exchange, the state
 * check and the first-backup kickoff are identical.
 */
async function handleOAuthCallback(
  request: Request,
  ctx: ExtensionContext | undefined,
  provider: CloudStorageProvider
): Promise<Response> {
  if (!ctx) return jsonError('Missing context', 500)
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')
  // Resolve exactly as /connect did: the token exchange repeats the
  // redirect_uri from the authorization request.
  const origin = resolveCallbackOrigin(url.origin)
  const redirect = (status: string, reason?: string) => {
    const target = new URL('/settings/backup', origin)
    target.searchParams.set('cloud_backup', status)
    target.searchParams.set('provider', provider.id)
    if (reason) target.searchParams.set('reason', reason)
    return NextResponse.redirect(target)
  }

  if (errorParam) {
    return redirect('error', errorParam)
  }
  if (!code || !state) {
    return redirect('error', 'missing_params')
  }

  const verified = verifyOAuthState(state)
  if (!verified) {
    return redirect('error', 'invalid_state')
  }
  if (verified.userId !== ctx.userId || verified.companyId !== ctx.companyId) {
    return redirect('error', 'state_mismatch')
  }

  try {
    const { refreshToken, accountLabel } = await provider.exchangeCode(origin, code)

    const connection: CloudConnection = {
      refresh_token_encrypted: encryptToken(refreshToken),
      account_email: accountLabel,
      connected_at: new Date().toISOString(),
      root_folder_id: null,
      company_folder_id: null,
      company_folder_path: null,
    }
    await ctx.settings.set(provider.keys.connection, connection)

    // First-time connections get daily auto-sync on by default: a
    // backup that defaults to off protects nobody. Reconnects keep
    // whatever schedule the user had. Each provider is scheduled
    // independently, so connecting a second one does not disturb the first.
    const existingSchedule = await ctx.settings.get<CloudSchedule>(
      provider.keys.schedule
    )
    const firstConnect = !existingSchedule
    if (firstConnect) {
      await ctx.settings.set(provider.keys.schedule, {
        ...DEFAULT_SCHEDULE,
        enabled: true,
      })
    }

    // Kick off the first backup after the redirect response is sent, so
    // the user lands back on the card immediately while the archive
    // builds in the background.
    after(async () => {
      try {
        await performSync({
          supabase: ctx.supabase,
          companyId: ctx.companyId,
          userId: ctx.userId,
          origin,
          includeDocuments: true,
          allowDocumentFallback: true,
          provider,
        })
      } catch (err) {
        ctx.log.error(`initial ${provider.id} sync after connect failed`, err)
      }
    })

    return redirect(firstConnect ? 'connected_first' : 'connected')
  } catch (err) {
    ctx.log.error(`${provider.id} oauth callback failed`, err)
    return redirect(
      'error',
      err instanceof Error ? err.message.slice(0, 80) : 'exchange_failed'
    )
  }
}

export const cloudBackupExtension: Extension = {
  id: 'cloud-backup',
  name: 'Molnsynkronisering',
  version: '1.1.0',
  sector: 'general',

  // The canonical entry point for cloud-backup is now `/import#cloud-backup`
  // (under "Importera/Exportera"). `/settings/backup` is preserved as a
  // permanent redirect to that anchor so legacy bookmarks and OAuth callbacks
  // keep working: see `app/(dashboard)/settings/backup/page.tsx`.
  settingsPanel: {
    label: 'Molnsynkronisering',
    path: '/settings/backup',
  },

  apiRoutes: [
    // Kick off OAuth: return the provider's consent URL.
    {
      method: 'POST',
      path: '/connect',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const resolved = resolveProvider(request, { requireConfigured: true })
        if ('error' in resolved) return resolved.error
        try {
          const origin = resolveCallbackOrigin(new URL(request.url).origin)
          const state = createOAuthState(ctx.userId, ctx.companyId)
          const url = resolved.provider.buildAuthorizationUrl(origin, state)
          return NextResponse.json({ url })
        } catch (err) {
          ctx.log.error('connect failed', err)
          return jsonError(
            err instanceof Error ? err.message : 'Could not start OAuth',
            500
          )
        }
      },
    },

    // Google redirects here after the user consents. The path is registered
    // with Google as an authorised redirect URI: never rename it.
    {
      method: 'GET',
      path: googleDriveProvider.callbackPath,
      handler: (request, ctx) => handleOAuthCallback(request, ctx, googleDriveProvider),
    },

    // Dropbox equivalent, on its own registered redirect URI.
    {
      method: 'GET',
      path: dropboxProvider.callbackPath,
      handler: (request, ctx) => handleOAuthCallback(request, ctx, dropboxProvider),
    },

    // Revoke the refresh token and clear the stored connection + schedule for
    // one provider. The other provider's records are untouched.
    {
      method: 'POST',
      path: '/disconnect',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        const { provider } = resolved
        try {
          const connection = await ctx.settings.get<CloudConnection>(
            provider.keys.connection
          )
          if (connection) {
            try {
              const refreshToken = decryptToken(connection.refresh_token_encrypted)
              await provider.revoke(
                refreshToken,
                resolveCallbackOrigin(new URL(request.url).origin)
              )
            } catch (err) {
              ctx.log.warn('token revoke failed (continuing)', err)
            }
          }
          await ctx.settings.clear(provider.keys.connection)
          await ctx.settings.clear(provider.keys.lastSync)
          await ctx.settings.clear(provider.keys.schedule)
          return NextResponse.json({ ok: true })
        } catch (err) {
          ctx.log.error('disconnect failed', err)
          return jsonError(
            err instanceof Error ? err.message : 'Disconnect failed',
            500
          )
        }
      },
    },

    // Read-only status used by the UI to show connected/last-sync info for
    // every provider. The top-level fields mirror Google Drive so clients
    // written before Dropbox existed keep working.
    {
      method: 'GET',
      path: '/status',
      handler: async (_request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const providers: CloudProviderStatus[] = []
        for (const provider of CLOUD_PROVIDERS) {
          providers.push(await readProviderStatus(ctx, provider))
        }
        const google =
          providers.find((p) => p.provider === googleDriveProvider.id) ?? null
        const status: CloudBackupStatus = {
          providers,
          connected: google?.connected ?? false,
          needs_reauth: google?.needs_reauth ?? false,
          account_email: google?.account_email ?? null,
          connected_at: google?.connected_at ?? null,
          last_sync: google?.last_sync ?? null,
          schedule: google?.schedule ?? null,
        }
        return NextResponse.json({ data: status })
      },
    },

    // Read one provider's auto-sync schedule. Returns the default (disabled)
    // shape if the user has never configured one.
    {
      method: 'GET',
      path: '/schedule',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        const schedule = await ctx.settings.get<CloudSchedule>(
          resolved.provider.keys.schedule
        )
        return NextResponse.json({ data: schedule ?? DEFAULT_SCHEDULE })
      },
    },

    // Update one provider's auto-sync schedule. Preserves the fields the cron
    // writes (`last_auto_sync_*`, failure counter, alert throttle): those are
    // not user-editable.
    {
      method: 'PUT',
      path: '/schedule',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        try {
          const body = (await request.json()) as {
            enabled?: boolean
            hour_local?: number
            hour_utc?: number
          }
          if (typeof body.enabled !== 'boolean') {
            return jsonError('enabled must be a boolean', 400)
          }
          const validHour = (h: unknown): h is number =>
            typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23

          let hourLocal: number | undefined
          let hourUtc: number
          if (validHour(body.hour_local)) {
            // Preferred: Stockholm wall-clock hour, DST-stable. hour_utc is
            // mirrored (today's offset) so legacy readers keep a sane value.
            hourLocal = body.hour_local
            hourUtc = stockholmHourToUtcHour(body.hour_local)
          } else if (validHour(body.hour_utc)) {
            // Legacy UTC-only request: leave hourLocal undefined so any
            // stored hour_local is cleared below. The scheduler prefers
            // hour_local, so keeping a stale value would make the schedule
            // ignore the requested UTC hour.
            hourUtc = body.hour_utc
          } else {
            return jsonError('hour_local must be an integer between 0 and 23', 400)
          }

          const key = resolved.provider.keys.schedule
          const existing = await ctx.settings.get<CloudSchedule>(key)
          const updated: CloudSchedule = {
            ...existing,
            enabled: body.enabled,
            hour_utc: hourUtc,
            hour_local: hourLocal,
            last_auto_sync_at: existing?.last_auto_sync_at ?? null,
            last_auto_sync_status: existing?.last_auto_sync_status ?? null,
            last_auto_sync_error: existing?.last_auto_sync_error ?? null,
          }
          await ctx.settings.set(key, updated)
          return NextResponse.json({ data: updated })
        } catch (err) {
          ctx.log.error('update schedule failed', err)
          return jsonError(
            err instanceof Error ? err.message : 'Invalid request body',
            400
          )
        }
      },
    },

    // Generate the archive set and sync it to one provider. Returns the sync
    // summary.
    {
      method: 'POST',
      path: '/sync',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        try {
          const body = (await request.json().catch(() => ({}))) as {
            include_documents?: boolean
            allow_document_fallback?: boolean
          }
          const origin = resolveCallbackOrigin(new URL(request.url).origin)
          const result = await performSync({
            supabase: ctx.supabase,
            companyId: ctx.companyId,
            userId: ctx.userId,
            origin,
            includeDocuments: body.include_documents !== false,
            allowDocumentFallback: body.allow_document_fallback === true,
            provider: resolved.provider,
          })

          if (!result.ok) {
            if (result.reason === 'not_connected') {
              return jsonError('not_connected', 400)
            }
            if (result.reason === 'needs_reauth') {
              return jsonError('needs_reauth', 400)
            }
            if (result.reason === 'archive_too_large') {
              return NextResponse.json(
                {
                  error: 'archive_too_large',
                  size_bytes: result.size_bytes,
                  size_limit_bytes: result.size_limit_bytes,
                },
                { status: 413 }
              )
            }
            return jsonError(result.message, 500)
          }

          return NextResponse.json({
            data: {
              ...result.lastSync,
              web_view_link: result.webViewLink,
              uploaded_count: result.uploadedCount,
              skipped_count: result.skippedCount,
            },
          })
        } catch (err) {
          ctx.log.error('sync failed', err)
          return jsonError(
            err instanceof Error ? err.message : 'Sync failed',
            500
          )
        }
      },
    },
  ],
}
