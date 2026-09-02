/**
 * POST /api/v1/companies/{companyId}/bank-connections/{connectionId}/sync
 *
 * Trigger a PSD2 sync of one bank connection now, instead of waiting for
 * the nightly cron. The window is not caller-controlled: the same gap-aware
 * incremental lookback the cron uses (7 days, widened to cover any gap since
 * last_synced_at, capped at 90). A connection synced within the last 15
 * minutes answers 429 BANK_SYNC_COOLDOWN with next_allowed_at, so an
 * unattended agent can never run up the Enable Banking bill by polling.
 *
 * What this cannot do: revive a dead consent. status=expired (or a session
 * the bank reports dead mid-sync) needs BankID in a browser; the response
 * says so and points at the connect link.
 *
 * The runner lives in the enable-banking extension. Core cannot import it
 * (CI guard), so it is reached through the registry-resolved `services`
 * channel declared in lib/bank-sync/trigger-sync-contract.ts, and a
 * deployment without the extension answers EXTENSION_DISABLED.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { ensureInitialized } from '@/lib/init'
import { extensionRegistry } from '@/lib/extensions/registry'
import {
  SYNC_COOLDOWN_MS,
  type EnableBankingServices,
} from '@/lib/bank-sync/trigger-sync-contract'

ensureInitialized()

const SyncResponse = z.object({
  connection_id: z.string().uuid(),
  bank: z.string().nullable(),
  imported: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  from_date: z.string(),
  to_date: z.string(),
  last_synced_at: z.string(),
})

registerEndpoint({
  operation: 'bank-connections.sync',
  method: 'POST',
  path: '/api/v1/companies/:companyId/bank-connections/:connectionId/sync',
  summary: 'Sync one bank connection now instead of waiting for the nightly run.',
  description:
    'Fetches new transactions and balances for one PSD2 bank connection right away. The window is chosen server-side: the last 7 days, widened to cover any gap since last_synced_at, capped at 90 days. Returns how many transactions were imported and the new last_synced_at. A connection synced within the last 15 minutes is refused with 429 BANK_SYNC_COOLDOWN and next_allowed_at: the data is already fresh. Not dry-runnable: the bank call itself is the side effect.',
  useWhen:
    'GET /bank-connections shows a stale last_synced_at on an active connection and you need current bank data before building on it (liquidity, reconciliation, a report), or the user asks for the latest transactions now.',
  doNotUseFor:
    'Polling. Connections sync every night on their own; call this once when freshness matters, then read /transactions. Fixing a dead connection: status=expired needs BankID in a browser, not a sync.',
  pitfalls: [
    'Idempotency-Key is optional here. If you send one, use a fresh key per attempt: a cooldown answer is never cached, but a completed sync is, and replaying it fetches nothing new.',
    '429 BANK_SYNC_COOLDOWN is not an error to retry immediately: wait until next_allowed_at (Retry-After is set), or just use the data you have.',
    '409 BANK_SESSION_EXPIRED means the bank reported the consent dead during the sync; the connection is now status=expired. Hand the user the connect link; no API call revives it.',
    'imported: 0 is normal on a quiet account. Banks report with up to 48 hours of delay, so today\'s transactions often arrive tomorrow.',
    'Costs one Enable Banking call per enabled account: 403 CAPABILITY_BLOCKED when the company has no bank_sync entitlement.',
  ],
  example: {
    response: {
      data: {
        connection_id: '4f6c…',
        bank: 'Swedbank',
        imported: 3,
        duplicates: 12,
        from_date: '2026-08-26',
        to_date: '2026-09-02',
        last_synced_at: '2026-09-02T09:14:03Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'low',
  idempotent: false,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: dataEnvelope(SyncResponse),
    errorCodes: [
      'BANK_SYNC_COOLDOWN',
      'BANK_SYNC_NOT_ACTIVE',
      'BANK_SYNC_NO_ACCOUNTS',
      'BANK_SESSION_EXPIRED',
      'BANK_SYNC_FAILED',
      'CAPABILITY_BLOCKED',
      'EXTENSION_DISABLED',
      'NOT_FOUND',
    ],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; connectionId: string }> }>(
  'bank-connections.sync',
  async (_request, ctx, params) => {
    const { connectionId } = await params.params

    const capBlocked = await requireCapability(ctx.supabase, ctx.companyId!, CAPABILITY.bank_sync)
    if (capBlocked) return capBlocked

    // The bank round-trip IS the side effect, so there is nothing to simulate.
    // Test keys never reach this line (the wrapper blocks them on endpoints
    // that cannot dry-run); a live key passing ?dry_run=true is told why.
    if (ctx.dryRun) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'dry_run',
          message: 'dry_run is not supported: the bank call is the side effect.',
          cooldown_ms: SYNC_COOLDOWN_MS,
        },
      })
    }

    // The enable-banking extension is opt-in (extensions.config.json) and the
    // registry is the runtime source of truth: absent registration means the
    // deployment does not offer PSD2 sync at all.
    const services = extensionRegistry.get('enable-banking')?.services as
      | Partial<EnableBankingServices>
      | undefined
    if (!services?.triggerConnectionSync) {
      return v1ErrorResponseFromCode('EXTENSION_DISABLED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    try {
      const result = await services.triggerConnectionSync(ctx.supabase, {
        companyId: ctx.companyId!,
        userId: ctx.userId,
        connectionId,
        log: ctx.log,
      })

      if (!result.ok) {
        const { ok: _ok, code, ...details } = result
        return v1ErrorResponseFromCode(code, ctx.log, {
          requestId: ctx.requestId,
          details,
          retryAfterSeconds: result.retry_after_seconds,
        })
      }

      const { ok: _ok, ...data } = result
      return ok(data, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
)
