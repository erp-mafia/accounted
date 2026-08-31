import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withConnectorAuth, type ConnectorContext } from '@/lib/connect/hosted/with-connector-auth'
import type { ConnectorEntitlements } from '@/lib/connect/contract'

/**
 * /api/connect/entitlements: what a self-hosted instance's connector key
 * entitles it to. The instance's hourly sync (lib/connect/instance/sync.ts)
 * POSTs its active company count (quantity billing input) and gets back
 * status, scopes and the paid period; it then writes source='connector'
 * capability grants that expire at min(now + 72h, period_end + 3d), so the
 * grant rows are the offline cache and the hosted service only has to be
 * reachable once every three days.
 *
 *   GET  -> entitlements (no side effects beyond last_seen_at)
 *   POST -> { active_company_count, instance_url?, app_version? } -> entitlements;
 *           records the count and pins instance_url on first report.
 */

const SyncReportSchema = z.object({
  active_company_count: z.number().int().min(0).max(1_000_000),
  instance_url: z.string().url().max(512).optional(),
  app_version: z.string().max(64).optional(),
})

function entitlementsOf(ctx: ConnectorContext, instanceUrl: string | null): ConnectorEntitlements {
  return {
    status: ctx.key.status,
    scopes: ctx.key.scopes,
    current_period_end: ctx.key.currentPeriodEnd,
    org_number: ctx.key.orgNumber,
    instance_url: instanceUrl,
    server_time: new Date().toISOString(),
  }
}

export const GET = withConnectorAuth('connect.entitlements', async (_request, ctx) => {
  return NextResponse.json({ data: entitlementsOf(ctx, ctx.key.instanceUrl) })
})

export const POST = withConnectorAuth('connect.entitlements', async (request, ctx) => {
  const parsed = await validateBody(request, SyncReportSchema, { log: ctx.log, operation: 'connect.entitlements' })
  if (!parsed.success) return parsed.response
  const report = parsed.data

  // instance_url is pinned: the first report claims it, later reports that
  // disagree are logged but never move it (a leaked key cannot re-home the
  // subscription to another instance).
  let instanceUrl = ctx.key.instanceUrl
  const pinNow = !!report.instance_url && !instanceUrl
  if (report.instance_url && instanceUrl && instanceUrl !== report.instance_url) {
    ctx.log.warn('sync reported a different instance_url than the pinned one', {
      pinned: instanceUrl,
      reported: report.instance_url,
    })
  }
  if (pinNow) instanceUrl = report.instance_url ?? null
  const lastSyncedAt = new Date().toISOString()
  // Two literal payloads rather than one built object: the no-phantom-columns
  // scanner resolves literals only. The pinning update additionally filters
  // on instance_url IS NULL so two concurrent first reports cannot both pin:
  // the loser's conditional update matches no row and re-reads the winner's
  // URL below (first-report-wins, later reports never move the pin).
  const { error, data: pinned } = pinNow
    ? await ctx.supabase
        .from('connector_keys')
        .update({
          active_company_count: report.active_company_count,
          last_synced_at: lastSyncedAt,
          instance_url: instanceUrl,
        })
        .eq('id', ctx.key.id)
        .is('instance_url', null)
        .select('instance_url')
    : await ctx.supabase
        .from('connector_keys')
        .update({ active_company_count: report.active_company_count, last_synced_at: lastSyncedAt })
        .eq('id', ctx.key.id)
        .select('instance_url')
  if (error) {
    ctx.log.error('failed to record connector sync', error)
    return NextResponse.json({ error: 'Failed to record sync', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
  if (pinNow && (pinned ?? []).length === 0) {
    // Lost the pin race: record the counters and surface the winner's pin.
    const { data: existing } = await ctx.supabase
      .from('connector_keys')
      .update({ active_company_count: report.active_company_count, last_synced_at: lastSyncedAt })
      .eq('id', ctx.key.id)
      .select('instance_url')
    instanceUrl = (existing?.[0] as { instance_url: string | null } | undefined)?.instance_url ?? null
    ctx.log.warn('instance_url pin race lost; keeping the first pin', {
      reported: report.instance_url,
      pinned: instanceUrl,
    })
  }
  return NextResponse.json({ data: entitlementsOf(ctx, instanceUrl) })
})
