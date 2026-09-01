import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyCronSecret } from '@/lib/auth/cron'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'
import { currentSkvEnvironment } from '@/extensions/general/skatteverket/lib/resolve-auth'
import {
  listConnections,
  recordProbeResult,
  type GrantStatus,
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
 * Downgrade guard: a single run may not turn more than this share of the
 * currently granted rows into fully denied ones. A mistyped pinned role code,
 * a renamed rollbeskrivning, or a partial register response would otherwise
 * deny every company in one night and silently push their background reads
 * back onto 65-minute personal tokens. Below MIN_ROWS the share test is
 * meaningless (one of two rows is 50%), so small fleets are guarded by the
 * absolute floor instead.
 */
export const MASS_DOWNGRADE_MIN_ROWS = 3
export const MASS_DOWNGRADE_MAX_SHARE = 0.5

/**
 * GET /api/extensions/skatteverket/ombud/sync/cron
 *
 * Daily ombudsregister sync (cron 30 3 * * *, half an hour before the
 * skattekonto sync so a grant signed yesterday is used this morning).
 *
 * Companies appoint Accounted as ombud in Skatteverket's e-service, and
 * nothing calls us back. One call to Ombudshantering v2
 * (GET /ombud/autentisieratOmbud on the system identity) lists every huvudman
 * that granted Accounted anything, and this route reconciles that list
 * against the company's OWN connection row:
 *
 *   - only rows that already exist are touched. A row exists because a
 *     member of that company pressed Verifiera or minted the deep link: the
 *     tenant's explicit opt-in. Rows are never created here, so a second
 *     tenant registered under the same org number (org-number reuse is
 *     allowed, tenant isolation is the boundary) gains nothing from a grant
 *     it did not ask for,
 *   - rows marked 'revoked' by the tenant's own "Koppla från" stay revoked
 *     until a member re-verifies; a still-standing grant at Skatteverket is
 *     not permission to switch the row back on,
 *   - a listed huvudman: granted/denied per behörighet from its active roles,
 *   - an unlisted huvudman: both behörigheter denied (withdrawn or expired),
 *     subject to the downgrade guards below.
 *
 * Runs in shadow mode as well as on: it only records grant state, never
 * changes which credentials a read uses (that policy lives in
 * resolveReadAuth). Off mode, or an unconfigured system flow, is a no-op.
 *
 * Downgrade guards: (1) an empty register while rows exist downgrades
 * nothing (a wrong base URL or a "wrong URI" 404 must not mass-revoke);
 * (2) a run that would fully deny more than MASS_DOWNGRADE_MAX_SHARE of the
 * currently granted rows (and at least MASS_DOWNGRADE_MIN_ROWS of them)
 * applies no downgrades at all and reports guardTripped, so a classification
 * or partial-response problem surfaces in the logs instead of in every
 * company's settings.
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

  const startedAt = Date.now()
  const environment = currentSkvEnvironment()
  const today = isoDate(new Date())

  let grants: Map<string, HuvudmanGrantSummary>
  try {
    grants = summarizeGrants(await listOmbudGrants({}, { emptyOn404: true }), today)
  } catch (error) {
    console.error('[ombud-sync-cron] ombudsregister lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Ombudsregister lookup failed' }, { status: 502 })
  }

  const rows = (await listConnections(environment)).filter((row) => row.status !== 'revoked')
  const decisions = planDecisions(rows, grants, today)

  const grantedNow = rows.filter(isAnyGranted).length
  const fullDowngrades = decisions.filter((d) => d.kind === 'downgrade').length
  const emptyRegisterGuard = grants.size === 0 && rows.length > 0
  const massDowngradeGuard =
    fullDowngrades >= MASS_DOWNGRADE_MIN_ROWS && fullDowngrades > grantedNow * MASS_DOWNGRADE_MAX_SHARE
  const guardTripped = emptyRegisterGuard || massDowngradeGuard
  if (guardTripped) {
    console.warn('[ombud-sync-cron] downgrade guard tripped; no row is downgraded this run', {
      environment,
      registryHuvudman: grants.size,
      rows: rows.length,
      grantedNow,
      plannedDowngrades: fullDowngrades,
      reason: emptyRegisterGuard ? 'empty_register' : 'mass_downgrade',
    })
  }

  const counts = { granted: 0, denied: 0, revoked: 0, unchanged: 0, failed: 0, skipped: 0 }
  for (const decision of decisions) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      counts.skipped += 1
      continue
    }
    if (decision.kind === 'downgrade' && guardTripped) {
      counts.skipped += 1
      continue
    }
    if (decision.kind === 'unchanged') {
      counts.unchanged += 1
      continue
    }
    const recorded = await recordProbeResult({
      companyId: decision.row.company_id,
      environment,
      orgNumber: decision.row.org_number,
      lasombud: { status: decision.lasombud, detail: decision.detail },
      momsOmbud: { status: decision.momsOmbud, detail: decision.detail },
      error: null,
    })
    if (!recorded) {
      counts.failed += 1
      continue
    }
    if (decision.kind === 'downgrade') counts.revoked += 1
    else if (decision.lasombud === 'granted' || decision.momsOmbud === 'granted') counts.granted += 1
    else counts.denied += 1
  }

  return NextResponse.json({
    environment,
    registryHuvudman: grants.size,
    rows: rows.length,
    ...counts,
    guardTripped,
    guardReason: emptyRegisterGuard ? 'empty_register' : massDowngradeGuard ? 'mass_downgrade' : null,
    durationMs: Date.now() - startedAt,
  })
}

function isAnyGranted(row: SkvCompanyConnection): boolean {
  return row.lasombud_status === 'granted' || row.moms_ombud_status === 'granted'
}

type Decision =
  | { kind: 'unchanged'; row: SkvCompanyConnection }
  | {
      /** 'record' updates from the register; 'downgrade' is a granted row that would lose every grant. */
      kind: 'record' | 'downgrade'
      row: SkvCompanyConnection
      lasombud: GrantStatus
      momsOmbud: GrantStatus
      detail: string
    }

/**
 * What the register says about each opted-in row, without writing anything:
 * the guards need the whole picture before the first upsert.
 */
export function planDecisions(
  rows: SkvCompanyConnection[],
  grants: Map<string, HuvudmanGrantSummary>,
  today: string
): Decision[] {
  const decisions: Decision[] = []
  for (const row of rows) {
    const summary = grants.get(row.org_number)
    const lasombud: GrantStatus = summary?.lasombud ? 'granted' : 'denied'
    const momsOmbud: GrantStatus = summary?.moms_ombud ? 'granted' : 'denied'
    const detail = summary
      ? `ombudsregister ${today}: roller ${summary.roles.join(', ') || 'inga'}`
      : `ombudsregister ${today}: huvudman saknas`
    // A row already showing exactly this state is left alone, so a never-listed
    // company is written once (unknown -> denied, "Saknas" in settings) and
    // then skipped every following night.
    if (row.lasombud_status === lasombud && row.moms_ombud_status === momsOmbud) {
      decisions.push({ kind: 'unchanged', row })
      continue
    }
    const losesEverything = isAnyGranted(row) && lasombud === 'denied' && momsOmbud === 'denied'
    decisions.push({ kind: losesEverything ? 'downgrade' : 'record', row, lasombud, momsOmbud, detail })
  }
  return decisions
}
