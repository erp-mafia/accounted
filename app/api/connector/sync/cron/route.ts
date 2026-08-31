import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { getConnectorConfig } from '@/lib/connect/instance/config'
import { syncConnectorEntitlements } from '@/lib/connect/instance/sync'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/connector/sync/cron: hourly on SELF-HOSTED deployments only
 * (docker/crontab.self-hosted via EXTRA_JOBS in scripts/generate-crontabs.ts;
 * deliberately not in vercel.json, hosted has no connector key).
 *
 * Validates GNUBOK_CONNECTOR_KEY against the hosted connector service,
 * reports the active company count, and refreshes the source='connector'
 * capability grants for every company on this instance. Grant expiry
 * (min(now + 72h, period_end + 3d)) is the offline grace: a hosted outage
 * shorter than that changes nothing here. An instance without a key answers
 * 200 with outcome not_configured, so the schedule costs one cheap request.
 */
export const maxDuration = 60

export const GET = withCronContext('cron.connector_sync', async (_request, ctx) => {
  if (!getConnectorConfig()) {
    return NextResponse.json({ data: { outcome: 'not_configured' } })
  }
  try {
    const result = await syncConnectorEntitlements(createServiceClient(), {
      instanceUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || null,
      appVersion: process.env.npm_package_version ?? null,
    })
    ctx.log.info('connector sync run', { ...result })
    return NextResponse.json({ data: result })
  } catch (err) {
    ctx.log.error('connector sync failed', err)
    return errorResponse(err, ctx.log, { requestId: ctx.requestId })
  }
})
