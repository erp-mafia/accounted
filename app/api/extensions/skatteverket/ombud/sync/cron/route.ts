import { NextResponse } from 'next/server'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { toRedovisare12 } from '@/lib/invariants/org-number'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'
import { currentSkvEnvironment } from '@/extensions/general/skatteverket/lib/resolve-auth'
import {
  listConnections,
  recordProbeResult,
  type SkvCompanyConnection,
} from '@/extensions/general/skatteverket/lib/connection-store'
import {
  isoDate,
  listOmbudGrants,
  summarizeGrants,
  type HuvudmanGrantSummary,
} from '@/extensions/general/skatteverket/lib/ombud-client'

ensureInitialized()

export const maxDuration = 60

const TIME_BUDGET_MS = 50_000

/**
 * GET /api/extensions/skatteverket/ombud/sync/cron
 *
 * Daily ombudsregister sync (cron 30 3 * * *, half an hour before the
 * skattekonto sync so a grant signed yesterday is used this morning).
 *
 * Companies appoint Accounted as ombud in Skatteverket's e-service, and
 * nothing calls us back. Before this cron the only way a grant became known
 * was a member pressing "Verifiera" in settings. Now one call to
 * Ombudshantering v2 (GET /ombud/autentisieratOmbud on the system identity)
 * lists every huvudman that granted Accounted anything, and this route
 * reconciles that list against skatteverket_company_connections:
 *
 *   - a huvudman whose org number matches a company: recordProbeResult with
 *     granted/denied per behörighet (creates the row if none exists, so a
 *     company never has to press Verifiera),
 *   - an existing row whose org number the register no longer lists: both
 *     behörigheter denied (the company withdrew, or the grant expired),
 *   - a huvudman matching no company: counted, not stored (they may sign up
 *     later; the next run picks them up).
 *
 * Runs in shadow mode as well as on: it only records grant state, never
 * changes which credentials a read uses (that policy lives in
 * resolveReadAuth). Off mode, or an unconfigured system flow, is a no-op.
 *
 * Mass-revocation guard: when the register returns zero grants but rows
 * exist locally, nothing is downgraded. A wrong base URL or a 404 that means
 * "wrong URI" rather than "empty" must not flip every verified company to
 * denied in one night; a genuinely empty register has no verified rows to
 * downgrade in the first place.
 */
export async function GET(request: Request) {
  const authError = verifyCronSecret(request)
  if (authError) return authError

  // Physical routes under app/api/extensions/<id>/ compile into every build,
  // including core-with-zero-extensions: the registry is what switches the
  // extension on, so a disabled extension must refuse visibly (503).
  loadExtensions()
  if (!extensionRegistry.get('skatteverket')) {
    return NextResponse.json(
      { error: 'Skatteverket extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 }
    )
  }

  if (process.env.SKATTEVERKET_ENABLED !== 'true') {
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }
  if (getSystemAuthMode() === 'off' || !isSystemAuthConfigured()) {
    return NextResponse.json({ message: 'System auth not active', processed: 0 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }
  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const startedAt = Date.now()
  const environment = currentSkvEnvironment()
  const today = isoDate(new Date())

  let grants: Map<string, HuvudmanGrantSummary>
  try {
    grants = summarizeGrants(await listOmbudGrants(), today)
  } catch (error) {
    console.error('[ombud-sync-cron] ombudsregister lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Ombudsregister lookup failed' }, { status: 502 })
  }

  // Org number -> companies. Several companies may legitimately share an org
  // number (org-number reuse is allowed), so keep a list.
  type CompanyRow = { company_id: string; org_number: string | null; entity_type: string | null }
  let companyRows: CompanyRow[]
  try {
    companyRows = await fetchAllRows<CompanyRow>(({ from, to }) =>
      supabase
        .from('company_settings')
        .select('company_id, org_number, entity_type')
        .not('org_number', 'is', null)
        .order('company_id', { ascending: true })
        .range(from, to),
    )
  } catch (error) {
    console.error('[ombud-sync-cron] Failed to fetch company settings', {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Failed to fetch companies' }, { status: 500 })
  }

  const companiesByOrgNumber = new Map<string, string[]>()
  for (const row of companyRows) {
    if (!row.org_number) continue
    let redovisare: string
    try {
      redovisare = toRedovisare12(
        row.org_number,
        row.entity_type === 'enskild_firma' ? 'enskild_firma' : 'aktiebolag',
      )
    } catch {
      continue
    }
    const list = companiesByOrgNumber.get(redovisare) ?? []
    list.push(row.company_id)
    companiesByOrgNumber.set(redovisare, list)
  }

  const existing = await listConnections(environment)
  const existingByCompany = new Map<string, SkvCompanyConnection>()
  for (const row of existing) existingByCompany.set(row.company_id, row)

  const counts = { granted: 0, denied: 0, revoked: 0, unmatched: 0, failed: 0, skipped: 0 }
  const guardTripped = grants.size === 0 && existing.length > 0

  // 1. Every huvudman the register lists.
  for (const summary of grants.values()) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      counts.skipped += 1
      continue
    }
    const companyIds = companiesByOrgNumber.get(summary.huvudman)
    if (!companyIds) {
      counts.unmatched += 1
      continue
    }
    for (const companyId of companyIds) {
      const recorded = await recordProbeResult({
        companyId,
        environment,
        orgNumber: summary.huvudman,
        lasombud: {
          status: summary.lasombud ? 'granted' : 'denied',
          detail: `ombudsregister ${today}: roller ${summary.roles.join(', ') || 'inga'}`,
        },
        momsOmbud: {
          status: summary.moms_ombud ? 'granted' : 'denied',
          detail: `ombudsregister ${today}: roller ${summary.roles.join(', ') || 'inga'}`,
        },
        error: null,
      })
      if (!recorded) {
        counts.failed += 1
        continue
      }
      if (summary.lasombud || summary.moms_ombud) counts.granted += 1
      else counts.denied += 1
      existingByCompany.delete(companyId)
    }
  }

  // 2. Rows the register no longer mentions.
  if (!guardTripped) {
    for (const row of existingByCompany.values()) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        counts.skipped += 1
        continue
      }
      const alreadyDown = row.lasombud_status !== 'granted' && row.moms_ombud_status !== 'granted'
      if (alreadyDown) continue
      const recorded = await recordProbeResult({
        companyId: row.company_id,
        environment,
        orgNumber: row.org_number,
        lasombud: { status: 'denied', detail: `ombudsregister ${today}: huvudman saknas` },
        momsOmbud: { status: 'denied', detail: `ombudsregister ${today}: huvudman saknas` },
        error: null,
      })
      if (recorded) counts.revoked += 1
      else counts.failed += 1
    }
  } else {
    console.warn('[ombud-sync-cron] register returned no grants while local rows exist; downgrades skipped', {
      environment,
      localRows: existing.length,
    })
  }

  return NextResponse.json({
    environment,
    registryHuvudman: grants.size,
    ...counts,
    guardTripped,
    durationMs: Date.now() - startedAt,
  })
}
