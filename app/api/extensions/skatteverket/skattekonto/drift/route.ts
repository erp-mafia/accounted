import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { computeSkattekontoDrift } from '@/extensions/general/skatteverket/lib/skattekonto-drift'
import { createLogger } from '@/lib/logger'

ensureInitialized()

const log = createLogger('skattekonto-drift-route')

/**
 * GET /api/extensions/skatteverket/skattekonto/drift
 *
 * Returns the current SKV saldo vs GL 1630 drift snapshot for the active
 * company. Backs the dashboard SkattekontoDriftTile. Returns null when no
 * snapshot exists yet (fresh company, never synced).
 *
 * Access is recorded through the structured logger (Sentry / Vercel logs)
 * because the response carries sensitive GL drift figures. Persisting every
 * dashboard tile poll into event_log would be too noisy — the structured
 * log line gives an auditable record without overrunning the 30-day event
 * log retention (SOC 2 CC8.1, ISO 27001 A.8.15).
 */
export async function GET(_request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)
  const ctx = createExtensionContext(supabase, user.id, companyId, 'skatteverket')

  const drift = await computeSkattekontoDrift(ctx)
  log.info('skattekonto drift snapshot accessed', {
    userId: user.id,
    companyId,
    hasDrift: drift !== null,
  })
  return NextResponse.json({ data: drift })
}
