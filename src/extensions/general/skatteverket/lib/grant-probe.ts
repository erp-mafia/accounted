import { skvRequestWithAuth, SkatteverketAuthError } from './api-client'
import { getSkattekontoBaseUrl } from './skattekonto-client'
import {
  getConnection,
  getConnectionOrThrow,
  recordProbeResult,
  type GrantStatus,
  type SkvBehorighet,
  type SkvCompanyConnection,
} from './connection-store'
import type { SkvAuditActor } from './audit'
import { currentSkvEnvironment } from './resolve-auth'
import {
  grantCountsFor,
  grantPredatesOptIn,
  listOmbudGrants,
  OmbudApiError,
  summarizeGrants,
} from './ombud-client'
import { createLogger } from '@/lib/logger'
import { todayIsoStockholm } from '@/lib/dates/iso'

const log = createLogger('skatteverket-grant-probe')

/**
 * Behorighet verification.
 *
 * After the user grants Accounted's org number a behorighet in Skatteverket's
 * Ombud och behorigheter e-service, nothing tells us: there is no callback.
 * Two ways to find out, tried in order:
 *
 *   1. The ombudsregister itself (Ombudshantering via API v2, scope `obr`):
 *      GET /ombud/autentisieratOmbud?huvudman={orgNumber} on SYSTEM
 *      credentials lists exactly which roles this company gave Accounted and
 *      for how long. Authoritative: a role present and active today is
 *      granted, a 200 without it is denied. Only a failure to ASK the
 *      register (scope missing, 5xx, timeout, unparsable body) is an
 *      'error', and then the service probes below decide instead.
 *
 *   2. Service probes (the pre-`obr` heuristic), one cheap read per
 *      behorighet on SYSTEM credentials:
 *      lasombud   : GET skattekonto saldo. 200 -> granted; felkod 3 (no
 *                   skattekonto registered) also proves authorization ->
 *                   granted-with-note; OMBUD_GRANT_MISSING (403) -> denied;
 *                   transient (5xx, timeout, rate limit) -> error.
 *      moms_ombud : GET moms /utkast for the current period. 200 or 404 (no
 *                   draft, but the gateway authorized us) -> granted;
 *                   OMBUD_GRANT_MISSING -> denied.
 *
 * 'error' never downgrades a previously granted state (connection-store
 * rule); only an explicit 'denied' does.
 *
 * Only the register can GRANT: a behörighet counts when it was signed on or
 * after the company's own opt-in (grantCountsFor), and the read probes cannot
 * see when anything was signed. A probe that would have said 'granted' says
 * 'error' instead; a 403 still proves the absence of a grant.
 */

export interface ProbeClassification {
  status: GrantStatus
  detail: string
  /** Machine-readable why, for the settings panel (stored in last_probe_detail). */
  reason?: 'predates_opt_in'
}

function classifyError(err: unknown): ProbeClassification {
  if (err instanceof SkatteverketAuthError) {
    if (err.code === 'OMBUD_GRANT_MISSING') {
      return { status: 'denied', detail: err.code }
    }
    // SYSTEM_AUTH_FAILED, RATE_LIMITED, ACCESS_DENIED (kill switch or APIGW)
    // are all our-side or transient: not evidence about the grant.
    return { status: 'error', detail: err.code }
  }
  return { status: 'error', detail: err instanceof Error ? err.message : String(err) }
}

async function probeLasombud(orgNumber: string, actor: SkvAuditActor): Promise<ProbeClassification> {
  try {
    const response = await skvRequestWithAuth(
      { mode: 'system' },
      'GET',
      `/skattekonton/${orgNumber}/saldo`,
      { endpoint: 'system-connection/verify/lasombud', ...actor, agRegistreradId: orgNumber },
      undefined,
      { baseUrl: getSkattekontoBaseUrl() }
    )
    if (response.ok) return { status: 'granted', detail: String(response.status) }

    // felkod 3 = no skattekonto registered: the authorization layer passed,
    // the account state is a separate matter.
    try {
      const body = (await response.json()) as { felkod?: number }
      if (body?.felkod === 3) {
        return { status: 'granted', detail: 'felkod 3 (inget skattekonto registrerat)' }
      }
      return { status: 'error', detail: `HTTP ${response.status}, felkod ${body?.felkod ?? 'okänd'}` }
    } catch {
      return { status: 'error', detail: `HTTP ${response.status}` }
    }
  } catch (err) {
    return classifyError(err)
  }
}

/** Current YYYYMM-style moms period for the draft probe. */
function currentMomsPeriod(): string {
  return todayIsoStockholm().slice(0, 7).replace('-', '')
}

async function probeMomsOmbud(orgNumber: string, actor: SkvAuditActor): Promise<ProbeClassification> {
  try {
    const period = currentMomsPeriod()
    const response = await skvRequestWithAuth(
      { mode: 'system' },
      'GET',
      `/utkast/${orgNumber}/${period}`,
      {
        endpoint: 'system-connection/verify/moms_ombud',
        ...actor,
        agRegistreradId: orgNumber,
        redovisningsperiod: period,
        // No draft for the period still proves the gateway authorized us.
        okStatuses: [404],
      }
    )
    // 404 just means no draft for the period: the gateway authorized us.
    if (response.ok || response.status === 404) {
      return { status: 'granted', detail: String(response.status) }
    }
    return { status: 'error', detail: `HTTP ${response.status}` }
  } catch (err) {
    return classifyError(err)
  }
}

export interface RegistryProbe {
  lasombud: ProbeClassification
  momsOmbud: ProbeClassification
}

/**
 * Ask the ombudsregister about one huvudman. Returns null when the register
 * could not be consulted (so the caller falls back to the service probes);
 * the reason is logged, and surfaces in the probe detail of the fallback.
 */
export async function probeViaOmbudsregister(
  orgNumber: string,
  optInDay: string,
  actor: SkvAuditActor,
  today: string = todayIsoStockholm()
): Promise<{ result: RegistryProbe; roles: string[] } | { result: null; reason: string }> {
  try {
    const posts = await listOmbudGrants({ huvudman: orgNumber }, actor)
    const summary = summarizeGrants(posts, today).get(orgNumber)
    const roles = summary?.roles ?? []
    // The company granted Accounted something, but none of it classifies as
    // either behörighet: possibly an unrecognised rollbeteckning (a wrong or
    // renamed code in OMBUD_ROLES or its env override) rather than a company
    // that chose only unrelated roles. 'error' never downgrades a granted row;
    // 'denied' would.
    if (roles.length > 0 && !summary?.recognized) {
      const detail = `ombudsregister: roller okända (${roles.join(', ')}); kontrollera rollkoderna (OMBUD_ROLES, SKATTEVERKET_OMBUD_ROLL_*)`
      return {
        result: {
          lasombud: { status: 'error', detail },
          momsOmbud: { status: 'error', detail },
        },
        roles,
      }
    }
    const describe = (key: 'lasombud' | 'moms_ombud'): ProbeClassification => {
      if (grantCountsFor(summary, key, optInDay)) {
        return { status: 'granted', detail: `ombudsregister: ${key} aktiv ${today}` }
      }
      if (grantPredatesOptIn(summary, key, optInDay)) {
        return {
          status: 'denied',
          detail: `ombudsregister: ${key} signerad ${summary?.signedFrom[key]}, före kopplingen ${optInDay}`,
          reason: 'predates_opt_in',
        }
      }
      return { status: 'denied', detail: `ombudsregister: ${key} saknas (roller: ${roles.join(', ') || 'inga'})` }
    }
    return {
      result: { lasombud: describe('lasombud'), momsOmbud: describe('moms_ombud') },
      roles,
    }
  } catch (err) {
    const reason =
      err instanceof OmbudApiError || err instanceof SkatteverketAuthError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err)
    log.warn('ombudsregister lookup unavailable, falling back to service probes', { orgNumber, reason })
    return { result: null, reason }
  }
}

/**
 * A read probe proves access but not WHEN the grant was signed, so it can
 * never establish one (see the header): its 'granted' becomes 'error', which
 * also never downgrades a grant the register established earlier.
 */
function cannotGrant(probe: ProbeClassification): ProbeClassification {
  if (probe.status !== 'granted') return probe
  return { status: 'error', detail: `${probe.detail}; signeringsdag okänd utan ombudsregistret` }
}

export interface GrantProbeResult {
  connection: SkvCompanyConnection | null
  lasombud: ProbeClassification
  momsOmbud: ProbeClassification
  /** 'registry' when the ombudsregister answered, 'service' when the read probes decided. */
  source: 'registry' | 'service'
}

/**
 * Verify both behorigheter for a company and persist the outcome.
 * The caller has already verified role + capability and resolved the
 * company's normalized 12-digit org number. `createdBy` is the user who asked
 * for the verification; without one the probe calls are audited as system
 * calls (null user).
 */
export async function probeCompanyGrants(
  companyId: string,
  orgNumber: string,
  createdBy?: string
): Promise<GrantProbeResult> {
  // The opt-in day: when this company first opted in for this org number. A
  // first check (no row yet) or a changed org number opts in today. A
  // failed read throws before anything is asked or recorded: guessing "no
  // row" would make today the opt-in day and deny a grant signed earlier.
  const stored = await getConnectionOrThrow(companyId, currentSkvEnvironment())
  const optInDay =
    todayIsoStockholm(stored && stored.org_number === orgNumber ? new Date(stored.created_at) : undefined)
  const actor: SkvAuditActor = { companyId, userId: createdBy ?? null }
  const registry = await probeViaOmbudsregister(orgNumber, optInDay, actor)

  let lasombud: ProbeClassification
  let momsOmbud: ProbeClassification
  let source: GrantProbeResult['source']
  if (registry.result) {
    ;({ lasombud, momsOmbud } = registry.result)
    source = 'registry'
  } else {
    lasombud = cannotGrant(await probeLasombud(orgNumber, actor))
    momsOmbud = cannotGrant(await probeMomsOmbud(orgNumber, actor))
    source = 'service'
    const note = ` (ombudsregister otillgängligt: ${registry.reason})`
    lasombud = { ...lasombud, detail: lasombud.detail + note }
    momsOmbud = { ...momsOmbud, detail: momsOmbud.detail + note }
  }

  log.info('grant probe completed', {
    companyId,
    source,
    lasombud: lasombud.status,
    momsOmbud: momsOmbud.status,
  })

  const connection = await recordProbeResult({
    companyId,
    environment: currentSkvEnvironment(),
    orgNumber,
    createdBy,
    lasombud: { status: lasombud.status, detail: lasombud.detail, reason: lasombud.reason },
    momsOmbud: { status: momsOmbud.status, detail: momsOmbud.detail, reason: momsOmbud.reason },
    error:
      lasombud.status === 'error' || momsOmbud.status === 'error'
        ? [lasombud, momsOmbud]
            .filter((p) => p.status === 'error')
            .map((p) => p.detail)
            .join('; ')
        : null,
  })

  return { connection, lasombud, momsOmbud, source }
}

/** last_error of a connection whose reads Skatteverket refuses while the ombudsregister lists the grant. */
const GRANT_ACTIVE_REFUSAL = 'SKV_403_GRANT_ACTIVE'

/**
 * A background read on system credentials was refused for this behorighet
 * (OMBUD_GRANT_MISSING). The api client names every unexplained system-mode
 * 403 so, which proves nothing about the grant by itself: the ombudsregister
 * decides, as in the hourly register sync, and the outcome is recorded through
 * recordProbeResult like any probe.
 *   - Withdrawn there: the behorighet is denied and the status follows the
 *     grants, so the next run uses the user token if there is one.
 *   - Still listed: the grant stays. Skatteverket then refuses a grant it
 *     lists, which only we can chase, so the first such refusal reaches error
 *     tracking and last_error keeps it.
 *   - Register unreachable or unreadable: nothing changes; the next run asks
 *     again.
 * It never writes 'revoked', the status of the user's own "Koppla från",
 * which the register sync skips for good (#115), and never grants anything.
 */
export async function recordGrantRefusal(
  companyId: string,
  behorighet: SkvBehorighet
): Promise<'withdrawn' | 'active' | 'unverified'> {
  const environment = currentSkvEnvironment()
  const connection = await getConnection(companyId, environment)
  if (!connection) return 'unverified'
  const registry = await probeViaOmbudsregister(
    connection.org_number,
    todayIsoStockholm(new Date(connection.created_at)),
    { companyId, userId: null }
  )
  const key = behorighet === 'lasombud' ? 'lasombud' : 'momsOmbud'
  const probe = registry.result?.[key]
  const record = { companyId, environment, orgNumber: connection.org_number }
  if (probe?.status === 'denied') {
    await recordProbeResult({ ...record, ...(key === 'lasombud' ? { lasombud: probe } : { momsOmbud: probe }), error: 'OMBUD_GRANT_MISSING' })
    return 'withdrawn'
  }
  if (probe?.status !== 'granted') return 'unverified'
  if (connection.last_error !== GRANT_ACTIVE_REFUSAL) {
    log.error('Skatteverket refused a system read on a grant the ombudsregister lists', { companyId, behorighet })
    await recordProbeResult({ ...record, error: GRANT_ACTIVE_REFUSAL })
  }
  return 'active'
}
