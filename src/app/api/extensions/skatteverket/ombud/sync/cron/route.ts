import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'
import { currentSkvEnvironment } from '@/extensions/general/skatteverket/lib/resolve-auth'
import {
  getOmbudClaimStandings,
  listConnections,
  recordProbeResult,
  type GrantStatus,
  type SkvCompanyConnection,
} from '@/extensions/general/skatteverket/lib/connection-store'
import {
  grantCountsFor,
  grantPredatesOptIn,
  listOmbudGrants,
  summarizeGrants,
  type HuvudmanGrantSummary,
} from '@/extensions/general/skatteverket/lib/ombud-client'
import type { SkvBehorighet } from '@/extensions/general/skatteverket/lib/connection-store'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'
import { todayIsoStockholm } from '@/lib/dates/iso'

export const maxDuration = 60

const TIME_BUDGET_MS = 50_000

/**
 * Downgrade guard: a single run may not turn more than this share of the
 * currently granted rows into fully denied ones. A mistyped role code
 * override, a renamed role code, or a partial register response would otherwise
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
 * Hourly ombudsregister sync (cron 50 * * * *), ten minutes before the
 * hourly skattekonto sync, which picks a grant recorded here up on its next
 * run; Kontrollera nu in the settings records one at once. Hourly because
 * Skatteverket takes from minutes to over an hour to list a fresh grant
 * (prod, 2026-11-08: 3, 18 and 52 minutes, one past the old nightly run), and
 * the settings card, Hem and Kom igång promise a check every hour while they
 * say "Väntar på Skatteverket". A run is one register call plus a write per
 * row that changed, and the guards below hold per run whatever the cadence.
 *
 * Companies appoint Accounted as ombud in Skatteverket's e-service, and
 * nothing calls us back. One call to Ombudshantering v2
 * (GET /ombud/autentisieratOmbud on the system identity) lists every huvudman
 * that granted Accounted anything, and this route reconciles that list
 * against the company's OWN connection row:
 *
 *   - only rows that already exist are touched. A row exists because a
 *     member of that company pressed Kontrollera nu or minted the deep link: the
 *     tenant's explicit opt-in. Rows are never created here,
 *   - a row whose company may not hold the connection on its org number
 *     (ombudClaimStanding: another live company claims it and this one is
 *     not the single claimant proven with BankID) is never granted, and a
 *     grant it holds is withdrawn,
 *   - rows marked 'revoked' by the tenant's own "Koppla från" stay revoked
 *     until a member re-verifies; a still-standing grant at Skatteverket is
 *     not permission to switch the row back on,
 *   - a listed huvudman: granted/denied per behörighet from its active roles,
 *     where a role signed before the row's opt-in day does not count
 *     (grantCountsFor: the org-number proof),
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
export const GET = withCronContext('cron.skatteverket_ombud_sync', async (_request, ctx) => {
  if (!isSkatteverketEnabled()) {
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }
  if (getSystemAuthMode() === 'off' || !isSystemAuthConfigured()) {
    return NextResponse.json({ message: 'System auth not active', processed: 0 })
  }

  const startedAt = Date.now()
  const environment = currentSkvEnvironment()
  const today = todayIsoStockholm()

  let grants: Map<string, HuvudmanGrantSummary>
  try {
    // The whole register: Accounted's own call as ombud, no company to audit
    // it against (logged by the transport instead).
    grants = summarizeGrants(await listOmbudGrants({}, 'ombud_register', { emptyOn404: true }), today)
  } catch (error) {
    ctx.log.error('ombudsregister lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Ombudsregister lookup failed' }, { status: 502 })
  }

  const rows = (await listConnections(environment)).filter((row) => row.status !== 'revoked')
  const standings = await getOmbudClaimStandings(
    rows.map((row) => ({ companyId: row.company_id, orgNumber: row.org_number }))
  )
  const heldBack = new Set(
    [...standings].filter(([, standing]) => standing !== 'clear').map(([companyId]) => companyId)
  )
  const decisions = planDecisions(rows, grants, today, heldBack)

  const grantedNow = rows.filter(isAnyGranted).length
  const fullDowngrades = decisions.filter((d) => d.kind === 'downgrade').length
  const emptyRegisterGuard = grants.size === 0 && rows.length > 0
  const massDowngradeGuard =
    fullDowngrades >= MASS_DOWNGRADE_MIN_ROWS && fullDowngrades > grantedNow * MASS_DOWNGRADE_MAX_SHARE
  const guardTripped = emptyRegisterGuard || massDowngradeGuard
  if (guardTripped) {
    ctx.log.warn('downgrade guard tripped; no row is downgraded this run', {
      environment,
      registryHuvudman: grants.size,
      rows: rows.length,
      grantedNow,
      plannedDowngrades: fullDowngrades,
      reason: emptyRegisterGuard ? 'empty_register' : 'mass_downgrade',
    })
  }

  const counts = { granted: 0, denied: 0, revoked: 0, unchanged: 0, contested: 0, unrecognized: 0, failed: 0, skipped: 0 }
  for (const decision of decisions) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      counts.skipped += 1
      continue
    }
    if (decision.kind === 'downgrade' && guardTripped) {
      counts.skipped += 1
      continue
    }
    if (decision.kind === 'contested') {
      counts.contested += 1
      if (!decision.lasombud || !decision.momsOmbud) continue
      const withdrawn = await recordProbeResult({
        companyId: decision.row.company_id,
        environment,
        orgNumber: decision.row.org_number,
        lasombud: { status: decision.lasombud, detail: decision.detail },
        momsOmbud: { status: decision.momsOmbud, detail: decision.detail },
        error: null,
      })
      if (withdrawn) counts.revoked += 1
      else counts.failed += 1
      continue
    }
    if (decision.kind === 'unrecognized') {
      counts.unrecognized += 1
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
      lasombud: { status: decision.lasombud, detail: decision.detail, ...reasonFor(decision, 'lasombud') },
      momsOmbud: { status: decision.momsOmbud, detail: decision.detail, ...reasonFor(decision, 'moms_ombud') },
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
}, { requireExtension: 'skatteverket' })

function reasonFor(
  decision: { predatesOptIn?: SkvBehorighet[] },
  key: SkvBehorighet
): { reason?: 'predates_opt_in' } {
  return decision.predatesOptIn?.includes(key) ? { reason: 'predates_opt_in' } : {}
}

function isAnyGranted(row: SkvCompanyConnection): boolean {
  return row.lasombud_status === 'granted' || row.moms_ombud_status === 'granted'
}

type Decision =
  | { kind: 'unchanged'; row: SkvCompanyConnection }
  /**
   * More than one live company claims this org number and this one is not
   * the single claimant proven with BankID: it is not granted, and a row that
   * already holds a grant has it withdrawn (the denied statuses are present
   * exactly then).
   */
  | {
      kind: 'contested'
      row: SkvCompanyConnection
      lasombud?: GrantStatus
      momsOmbud?: GrantStatus
      detail?: string
    }
  /** The register lists roles we cannot name (a wrong or renamed role code): never a denial. */
  | { kind: 'unrecognized'; row: SkvCompanyConnection }
  | {
      /** 'record' updates from the register; 'downgrade' is a granted row that would lose every grant. */
      kind: 'record' | 'downgrade'
      row: SkvCompanyConnection
      lasombud: GrantStatus
      momsOmbud: GrantStatus
      detail: string
      /** Behörigheter active at Skatteverket but signed before the row's opt-in. */
      predatesOptIn?: SkvBehorighet[]
    }

/**
 * What the register says about each opted-in row, without writing anything:
 * the guards need the whole picture before the first upsert.
 */
export function planDecisions(
  rows: SkvCompanyConnection[],
  grants: Map<string, HuvudmanGrantSummary>,
  today: string,
  /** Company ids whose claim on their row's org number is not clear (ombudClaimStanding). */
  heldBack: Set<string> = new Set()
): Decision[] {
  const decisions: Decision[] = []
  for (const row of rows) {
    if (heldBack.has(row.company_id)) {
      // A held-back row is frozen in both directions: never granted, and any
      // grant already recorded on it is withdrawn until it is the one claimant
      // proven with BankID. Withdrawn outside the downgrade guards on purpose:
      // this is the guard.
      if (isAnyGranted(row)) {
        const detail = `ombudsregister ${today}: organisationsnumret används av fler än ett företag och är inte bekräftat med BankID i bara det här`
        decisions.push({ kind: 'contested', row, lasombud: 'denied', momsOmbud: 'denied', detail })
      } else {
        decisions.push({ kind: 'contested', row })
      }
      continue
    }
    const summary = grants.get(row.org_number)
    if (summary && summary.roles.length > 0 && !summary.recognized) {
      // Same rule as probeViaOmbudsregister: unknown role codes may be a
      // wrong role code on our side, not a company withdrawing anything.
      decisions.push({ kind: 'unrecognized', row })
      continue
    }
    const optInDay = todayIsoStockholm(new Date(row.created_at))
    const lasombud: GrantStatus = grantCountsFor(summary, 'lasombud', optInDay) ? 'granted' : 'denied'
    const momsOmbud: GrantStatus = grantCountsFor(summary, 'moms_ombud', optInDay) ? 'granted' : 'denied'
    const predatesOptIn = (['lasombud', 'moms_ombud'] as const).filter((key) =>
      grantPredatesOptIn(summary, key, optInDay)
    )
    const detail = summary
      ? `ombudsregister ${today}: roller ${summary.roles.join(', ') || 'inga'}` +
        (predatesOptIn.length > 0 ? `; signerad före kopplingen ${optInDay}` : '')
      : `ombudsregister ${today}: huvudman saknas`
    // A row already showing exactly this state is left alone, so a never-listed
    // company is written once (unknown -> denied, "Väntar på Skatteverket" in
    // settings) and then skipped every following run.
    if (row.lasombud_status === lasombud && row.moms_ombud_status === momsOmbud) {
      decisions.push({ kind: 'unchanged', row })
      continue
    }
    const losesEverything = isAnyGranted(row) && lasombud === 'denied' && momsOmbud === 'denied'
    decisions.push({
      kind: losesEverything ? 'downgrade' : 'record',
      row,
      lasombud,
      momsOmbud,
      detail,
      ...(predatesOptIn.length > 0 ? { predatesOptIn } : {}),
    })
  }
  return decisions
}
