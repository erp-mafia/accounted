import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import {
  createOAuthState,
  decryptToken,
  encryptToken,
  verifyOAuthState,
} from './lib/crypto'
import { performSync } from './lib/sync'
import { patchScheduleRow, readScheduleRow, withManualRunClaim } from './lib/run-claim'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolveCallbackOrigin } from '@/lib/auth/callback-origin'
import { resolveOAuthOrigin } from '@/lib/auth/oauth-flows'
import { createServiceClient } from '@/lib/supabase/server'
import { stockholmHourToUtcHour } from './lib/schedule'
import { CLOUD_PROVIDERS, providerFromRequest } from './lib/provider-registry'
import { googleDriveProvider } from './lib/google-provider'
import { dropboxProvider } from './lib/dropbox-provider'
import { CloudScopeMissingError, type CloudStorageProvider } from './lib/cloud-provider'
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
    reauth_reason:
      connection?.status === 'needs_reauth'
        ? (connection.needs_reauth_reason ?? 'token_revoked')
        : null,
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
  ctx: ExtensionContext,
  provider: CloudStorageProvider
): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')
  // Resolve exactly as /connect did: the token exchange repeats the
  // redirect_uri from the authorization request.
  const origin = resolveCallbackOrigin(url.origin)
  const verified = state ? verifyOAuthState(state) : null
  // Land the person on the domain they started from (a brand domain or the
  // app), which is also the host serving this request after the hop.
  const landingOrigin = verified?.origin ?? origin
  const redirect = (status: string, reason?: string) => {
    const target = new URL('/settings/backup', landingOrigin)
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
        // Under the run claim: a new schedule is due at once, so the hourly
        // cron can start on the same destination while this first backup is
        // still uploading, and a first Drive upload has no file to update.
        const run = await withManualRunClaim(
          ctx.supabase,
          { companyId: ctx.companyId, scheduleKey: provider.keys.schedule },
          () =>
            performSync({
              supabase: ctx.supabase,
              companyId: ctx.companyId,
              userId: ctx.userId,
              origin,
              includeDocuments: true,
              allowDocumentFallback: true,
              provider,
            })
        )
        if (run.busy) {
          ctx.log.info(`initial ${provider.id} sync left to the run already in progress`)
        }
      } catch (err) {
        ctx.log.error(`initial ${provider.id} sync after connect failed`, err)
      }
    })

    return redirect(firstConnect ? 'connected_first' : 'connected')
  } catch (err) {
    if (err instanceof CloudScopeMissingError) {
      // The person left the storage box unticked on the consent screen: their
      // choice, not our failure. Nothing was stored; the card says what to do.
      ctx.log.info(`${provider.id} grant refused: storage scope not granted`)
      return redirect('error', 'missing_scope')
    }
    ctx.log.error(`${provider.id} oauth callback failed`, err)
    return redirect(
      'error',
      err instanceof Error ? err.message.slice(0, 80) : 'exchange_failed'
    )
  }
}

/**
 * Whether another company holds a connection to the same provider account.
 * Google ends the whole grant for the account when one token is revoked, so
 * revoking on disconnect would silently stop every other company's backup on
 * that account (a byrå backing up several clients to one Drive). Unknown
 * counts as shared: an unrevoked grant is harmless, a wrong revoke is not.
 */
async function grantSharedWithOtherCompany(
  provider: CloudStorageProvider,
  connection: CloudConnection,
  companyId: string
): Promise<boolean> {
  if (!connection.account_email) return true
  // Service role: RLS shows only the active company's rows.
  const { count, error } = await createServiceClient()
    .from('extension_data')
    .select('id', { count: 'exact', head: true })
    .eq('extension_id', 'cloud-backup')
    .eq('key', provider.keys.connection)
    .eq('value->>account_email', connection.account_email)
    .neq('company_id', companyId)
  return error !== null || (count ?? 0) > 0
}

/** Where the provider callbacks hand the browser on; see oauthCallbackHop. */
const COMPLETE_PATH = '/oauth/complete'

/**
 * The provider's registered redirect URI always points at the canonical app
 * host, but the session cookie is host-only: someone who started on a brand
 * domain arrives here without one, and an authenticated callback answered
 * them with a bare 401. This unauthenticated hop only forwards the provider's
 * answer to the origin sealed in the state, where the authenticated
 * /oauth/complete finishes the flow with the person's own session. A state
 * that does not verify forwards to the app origin, which reports it.
 */
function oauthCallbackHop(request: Request, provider: CloudStorageProvider): Response {
  const url = new URL(request.url)
  const state = url.searchParams.get('state')
  const verified = state ? verifyOAuthState(state) : null
  const target = new URL(
    `/api/extensions/ext/cloud-backup${COMPLETE_PATH}`,
    verified?.origin ?? resolveCallbackOrigin(url.origin)
  )
  for (const key of ['code', 'state', 'error']) {
    const value = url.searchParams.get(key)
    if (value) target.searchParams.set(key, value)
  }
  target.searchParams.set('provider', provider.id)
  return NextResponse.redirect(target)
}

export const cloudBackupExtension: Extension = {
  id: 'cloud-backup',
  name: 'Molnsynkronisering',
  version: '1.1.0',
  sector: 'general',

  apiRoutes: [
    // Kick off OAuth: return the provider's consent URL.
    {
      method: 'POST',
      path: '/connect',
      handler: async (request, ctx) => {
        const resolved = resolveProvider(request, { requireConfigured: true })
        if ('error' in resolved) return resolved.error
        try {
          const origin = resolveCallbackOrigin(new URL(request.url).origin)
          const state = createOAuthState(
            ctx.userId,
            ctx.companyId,
            await resolveOAuthOrigin(request)
          )
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

    // Each provider redirects here after consent. The paths are registered
    // with the providers as authorised redirect URIs: never rename them.
    ...CLOUD_PROVIDERS.map((provider) => ({
      method: 'GET' as const,
      path: provider.callbackPath,
      skipAuth: true as const,
      handler: async (request: Request) => oauthCallbackHop(request, provider),
    })),

    // The hop's destination, on the host the flow started from.
    {
      method: 'GET',
      path: COMPLETE_PATH,
      handler: async (request, ctx) => {
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        return handleOAuthCallback(request, ctx, resolved.provider)
      },
    },

    // Revoke the refresh token and clear the stored connection + schedule for
    // one provider. The other provider's records are untouched.
    {
      method: 'POST',
      path: '/disconnect',
      handler: async (request, ctx) => {
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        const { provider } = resolved
        try {
          const connection = await ctx.settings.get<CloudConnection>(
            provider.keys.connection
          )
          if (connection) {
            try {
              if (await grantSharedWithOtherCompany(provider, connection, ctx.companyId)) {
                ctx.log.info(`${provider.id} grant shared with another company; not revoked`)
              } else {
                const refreshToken = decryptToken(connection.refresh_token_encrypted)
                await provider.revoke(
                  refreshToken,
                  resolveCallbackOrigin(new URL(request.url).origin)
                )
              }
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

    // Update one provider's auto-sync schedule. Preserves the fields the runs
    // write (the run claim, `last_auto_sync_*`, failure counter, alert
    // throttle): those are not user-editable, and the edit is written at the
    // record's version so a run's write in between is kept.
    {
      method: 'PUT',
      path: '/schedule',
      handler: async (request, ctx) => {
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
          // Only the fields a person edits. Everything else on the record is
          // the runs': the claim, the outcome, the failure count and the
          // alert throttle.
          const edit = (current: CloudSchedule | null): CloudSchedule => ({
            ...current,
            enabled: body.enabled as boolean,
            // Off to on: the card's stale-backup warning counts from here.
            ...(body.enabled && !current?.enabled ? { enabled_at: new Date().toISOString() } : {}),
            hour_utc: hourUtc,
            hour_local: hourLocal,
            last_auto_sync_at: current?.last_auto_sync_at ?? null,
            last_auto_sync_status: current?.last_auto_sync_status ?? null,
            last_auto_sync_error: current?.last_auto_sync_error ?? null,
          })
          const recordKey = { companyId: ctx.companyId, scheduleKey: key }
          const row = await readScheduleRow(ctx.supabase, recordKey)
          if (!row) {
            // No record yet, so no run to race with.
            const created = edit(null)
            await ctx.settings.set(key, created)
            return NextResponse.json({ data: created })
          }
          // Written at the version read, and on the record as it is then when
          // a run wrote in between: a plain read and write put back a claim
          // its run had released (the next hour then counted a failed night
          // that never happened) or erased one a run still held (letting a
          // second run start beside it, and dropping the first one's outcome).
          // The member who saves becomes the record's owner, as a plain save
          // always made them: the failure mail goes to them and the backup runs
          // as them, so a member who has left does not keep the alerts.
          const saved: { value: CloudSchedule | null } = { value: null }
          const outcome = await patchScheduleRow(ctx.supabase, recordKey, row, (current) => (saved.value = edit(current)), { user_id: ctx.userId })
          if (outcome !== 'written' || !saved.value) {
            // Removed meanwhile (disconnected), or written over on every try.
            return errorResponseFromCode('CONFLICT', ctx.log, {
              reason: `schedule edit for ${resolved.provider.id} not saved: ${outcome}`,
            })
          }
          return NextResponse.json({ data: saved.value })
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
        const resolved = resolveProvider(request)
        if ('error' in resolved) return resolved.error
        try {
          const body = (await request.json().catch(() => ({}))) as {
            include_documents?: boolean
            allow_document_fallback?: boolean
          }
          const origin = resolveCallbackOrigin(new URL(request.url).origin)
          // One run per destination at a time (lib/run-claim.ts): while the
          // nightly backup is uploading, a second run would upload the same
          // archives next to it.
          const run = await withManualRunClaim(
            ctx.supabase,
            { companyId: ctx.companyId, scheduleKey: resolved.provider.keys.schedule },
            () =>
              performSync({
                supabase: ctx.supabase,
                companyId: ctx.companyId,
                userId: ctx.userId,
                origin,
                includeDocuments: body.include_documents !== false,
                allowDocumentFallback: body.allow_document_fallback === true,
                provider: resolved.provider,
              })
          )
          if (run.busy) return jsonError('sync_in_progress', 409)
          const result = run.result

          if (!result.ok) {
            if (result.reason === 'not_connected') {
              return jsonError('not_connected', 400)
            }
            if (result.reason === 'needs_reauth') {
              return NextResponse.json(
                { error: 'needs_reauth', reauth_reason: result.reauthReason ?? null },
                { status: 400 }
              )
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
