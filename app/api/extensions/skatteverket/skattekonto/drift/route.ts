import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { computeSkattekontoDrift } from '@/extensions/general/skatteverket/lib/skattekonto-drift'

ensureInitialized()

/**
 * GET /api/extensions/skatteverket/skattekonto/drift
 *
 * Returns the current SKV saldo vs GL 1630 drift snapshot for the active
 * company. Backs the dashboard SkattekontoDriftTile. Returns null when no
 * snapshot exists yet (fresh company, never synced).
 *
 * Access is recorded through the structured logger (Sentry / Vercel logs)
 * because the response carries sensitive GL drift figures. Persisting every
 * dashboard tile poll into event_log would be too noisy: the structured
 * log line gives an auditable record without overrunning the 30-day event
 * log retention (SOC 2 CC8.1, ISO 27001 A.8.15).
 */
export const GET = withRouteContext(
  'skatteverket.skattekonto.drift',
  async (_request, { supabase, user, companyId, log, requestId }) => {
    const ctx = createExtensionContext(supabase, user.id, companyId, 'skatteverket', requestId)

    const drift = await computeSkattekontoDrift(ctx)
    log.info('skattekonto drift snapshot accessed', {
      hasDrift: drift !== null,
    })
    return NextResponse.json({ data: drift })
  },
)
