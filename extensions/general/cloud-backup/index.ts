import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserEmail,
  getOAuthEnv,
  revokeToken,
} from './lib/google-oauth'
import {
  createOAuthState,
  decryptToken,
  encryptToken,
  verifyOAuthState,
} from './lib/crypto'
import {
  performSync,
  CONNECTION_KEY,
  LAST_SYNC_KEY,
  SCHEDULE_KEY,
} from './lib/sync'
import { stockholmHourToUtcHour } from './lib/schedule'
import type {
  CloudBackupStatus,
  GoogleDriveConnection,
  GoogleDriveLastSync,
  GoogleDriveSchedule,
} from './types'

function jsonError(message: string, status = 500): Response {
  return NextResponse.json({ error: message }, { status })
}

async function loadConnection(
  ctx: ExtensionContext
): Promise<GoogleDriveConnection | null> {
  return ctx.settings.get<GoogleDriveConnection>(CONNECTION_KEY)
}

const DEFAULT_SCHEDULE: GoogleDriveSchedule = {
  enabled: false,
  hour_utc: 3,
  hour_local: 5, // 05:00 Swedish time, DST-stable: low-traffic default
  last_auto_sync_at: null,
  last_auto_sync_status: null,
  last_auto_sync_error: null,
}

export const cloudBackupExtension: Extension = {
  id: 'cloud-backup',
  name: 'Molnsynkronisering',
  version: '1.0.0',
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
    // Kick off OAuth: return the Google consent URL.
    {
      method: 'POST',
      path: '/connect',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        try {
          const origin = new URL(request.url).origin
          const env = getOAuthEnv(origin)
          const state = createOAuthState(ctx.userId, ctx.companyId)
          const url = buildAuthorizationUrl(env, state)
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

    // Google redirects here after the user consents.
    {
      method: 'GET',
      path: '/oauth/callback',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const errorParam = url.searchParams.get('error')
        const origin = url.origin
        const redirect = (status: string, reason?: string) => {
          const target = new URL('/settings/backup', origin)
          target.searchParams.set('cloud_backup', status)
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
          const env = getOAuthEnv(origin)
          const tokens = await exchangeCodeForTokens(env, code)
          const email = await fetchUserEmail(tokens.access_token)

          const connection: GoogleDriveConnection = {
            refresh_token_encrypted: encryptToken(tokens.refresh_token),
            account_email: email,
            connected_at: new Date().toISOString(),
            root_folder_id: null,
            company_folder_id: null,
          }
          await ctx.settings.set(CONNECTION_KEY, connection)

          // First-time connections get daily auto-sync on by default: a
          // backup that defaults to off protects nobody. Reconnects keep
          // whatever schedule the user had.
          const existingSchedule =
            await ctx.settings.get<GoogleDriveSchedule>(SCHEDULE_KEY)
          const firstConnect = !existingSchedule
          if (firstConnect) {
            await ctx.settings.set(SCHEDULE_KEY, {
              ...DEFAULT_SCHEDULE,
              enabled: true,
            })
          }

          // Kick off the first backup after the redirect response is sent, so
          // the user lands back on the card immediately while the archive
          // builds in the background.
          const syncOrigin = process.env.NEXT_PUBLIC_APP_URL || origin
          after(async () => {
            try {
              await performSync({
                supabase: ctx.supabase,
                companyId: ctx.companyId,
                userId: ctx.userId,
                origin: syncOrigin,
                includeDocuments: true,
                allowDocumentFallback: true,
              })
            } catch (err) {
              ctx.log.error('initial sync after connect failed', err)
            }
          })

          return redirect(firstConnect ? 'connected_first' : 'connected')
        } catch (err) {
          ctx.log.error('oauth callback failed', err)
          return redirect(
            'error',
            err instanceof Error ? err.message.slice(0, 80) : 'exchange_failed'
          )
        }
      },
    },

    // Revoke the refresh token and clear the stored connection + schedule.
    {
      method: 'POST',
      path: '/disconnect',
      handler: async (_request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        try {
          const connection = await loadConnection(ctx)
          if (connection) {
            try {
              const refreshToken = decryptToken(connection.refresh_token_encrypted)
              await revokeToken(refreshToken)
            } catch (err) {
              ctx.log.warn('token revoke failed (continuing)', err)
            }
          }
          await ctx.settings.clear(CONNECTION_KEY)
          await ctx.settings.clear(LAST_SYNC_KEY)
          await ctx.settings.clear(SCHEDULE_KEY)
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

    // Read-only status used by the UI to show connected/last-sync info.
    {
      method: 'GET',
      path: '/status',
      handler: async (_request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const connection = await loadConnection(ctx)
        const lastSync = await ctx.settings.get<GoogleDriveLastSync>(LAST_SYNC_KEY)
        const schedule = await ctx.settings.get<GoogleDriveSchedule>(SCHEDULE_KEY)
        const status: CloudBackupStatus = {
          connected: !!connection,
          needs_reauth: connection?.status === 'needs_reauth',
          account_email: connection?.account_email ?? null,
          connected_at: connection?.connected_at ?? null,
          last_sync: lastSync ?? null,
          schedule: schedule ?? null,
        }
        return NextResponse.json({ data: status })
      },
    },

    // Read the auto-sync schedule. Returns the default (disabled) shape if
    // the user has never configured one.
    {
      method: 'GET',
      path: '/schedule',
      handler: async (_request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const schedule = await ctx.settings.get<GoogleDriveSchedule>(SCHEDULE_KEY)
        return NextResponse.json({ data: schedule ?? DEFAULT_SCHEDULE })
      },
    },

    // Update the auto-sync schedule. Preserves the fields the cron writes
    // (`last_auto_sync_*`, failure counter, alert throttle): those are not
    // user-editable.
    {
      method: 'PUT',
      path: '/schedule',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
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

          const existing = await ctx.settings.get<GoogleDriveSchedule>(SCHEDULE_KEY)
          const updated: GoogleDriveSchedule = {
            ...existing,
            enabled: body.enabled,
            hour_utc: hourUtc,
            hour_local: hourLocal,
            last_auto_sync_at: existing?.last_auto_sync_at ?? null,
            last_auto_sync_status: existing?.last_auto_sync_status ?? null,
            last_auto_sync_error: existing?.last_auto_sync_error ?? null,
          }
          await ctx.settings.set(SCHEDULE_KEY, updated)
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

    // Generate the archive set and sync it to Drive. Returns the sync summary.
    {
      method: 'POST',
      path: '/sync',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        try {
          const body = (await request.json().catch(() => ({}))) as {
            include_documents?: boolean
            allow_document_fallback?: boolean
          }
          const origin =
            process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
          const result = await performSync({
            supabase: ctx.supabase,
            companyId: ctx.companyId,
            userId: ctx.userId,
            origin,
            includeDocuments: body.include_documents !== false,
            allowDocumentFallback: body.allow_document_fallback === true,
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
