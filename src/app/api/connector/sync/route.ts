import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isSelfHosted } from '@/lib/env/public-flags'
import { createServiceClient } from '@/lib/supabase/server'
import { getConnectorConfig } from '@/lib/connect/instance/config'
import { syncConnectorEntitlements } from '@/lib/connect/instance/sync'
import {
  endManualSync,
  tryBeginManualSync,
} from '@/lib/connect/instance/manual-sync-throttle'

/**
 * POST /api/connector/sync: operator-triggered run of the same entitlement
 * sync the hourly self-hosted cron performs (/api/connector/sync/cron),
 * for the "Synka nu" row in Settings -> Abonnemang. Runs with the service
 * client because grants are instance-wide (every company on the instance),
 * so the caller must hold a non-viewer role (requireWrite) and runs are
 * cooldown-gated: each one reports to the hosted entitlements endpoint.
 *
 * Hosted (or an instance without a key) answers 200 not_configured rather
 * than an error: the settings row is hidden there and this is the backstop.
 */
export const maxDuration = 60

export const POST = withRouteContext(
  'connector.sync',
  async (_request, { log }) => {
    if (!isSelfHosted() || !getConnectorConfig()) {
      return NextResponse.json({ data: { outcome: 'not_configured' } })
    }
    if (!tryBeginManualSync()) {
      return NextResponse.json(
        {
          error: {
            code: 'CONNECTOR_SYNC_COOLDOWN',
            message: 'En synkronisering kördes nyss. Vänta en minut och försök igen.',
            message_en: 'A sync just ran. Wait a minute and try again.',
          },
        },
        { status: 429, headers: { 'Retry-After': '60' } },
      )
    }
    try {
      const result = await syncConnectorEntitlements(createServiceClient(), {
        instanceUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || null,
        appVersion: process.env.npm_package_version ?? null,
      })
      log.info('manual connector sync run', { ...result })
      return NextResponse.json({ data: result })
    } finally {
      endManualSync()
    }
  },
  { requireWrite: true },
)
