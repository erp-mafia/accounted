import { skvRequestWithAuth, SkatteverketAuthError } from './api-client'
import { getSkattekontoBaseUrl } from './skattekonto-client'
import { recordProbeResult, type GrantStatus, type SkvCompanyConnection } from './connection-store'
import { currentSkvEnvironment } from './resolve-auth'
import { isoDate, listOmbudGrants, OmbudApiError, summarizeGrants } from './ombud-client'
import { createLogger } from '@/lib/logger'

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
 */

export interface ProbeClassification {
  status: GrantStatus
  detail: string
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

async function probeLasombud(orgNumber: string): Promise<ProbeClassification> {
  try {
    const response = await skvRequestWithAuth(
      { mode: 'system' },
      'GET',
      `/skattekonton/${orgNumber}/saldo`,
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
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
}

async function probeMomsOmbud(orgNumber: string): Promise<ProbeClassification> {
  try {
    const response = await skvRequestWithAuth(
      { mode: 'system' },
      'GET',
      `/utkast/${orgNumber}/${currentMomsPeriod()}`
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
  today: string = isoDate(new Date())
): Promise<{ result: RegistryProbe; roles: string[] } | { result: null; reason: string }> {
  try {
    const posts = await listOmbudGrants({ huvudman: orgNumber })
    const summary = summarizeGrants(posts, today).get(orgNumber)
    const roles = summary?.roles ?? []
    // The company granted Accounted something, but none of it classifies as
    // either behörighet: far more likely an unrecognised rollbeteckning (codes
    // not pinned yet, or a renamed rollbeskrivning) than a company that chose
    // only unrelated roles. 'error' never downgrades a granted row; 'denied'
    // would. Pin the codes and the ambiguity disappears.
    if (roles.length > 0 && !summary?.recognized) {
      const detail = `ombudsregister: roller okända (${roles.join(', ')}); pinna rollkoderna`
      return {
        result: {
          lasombud: { status: 'error', detail },
          momsOmbud: { status: 'error', detail },
        },
        roles,
      }
    }
    const describe = (granted: boolean, key: 'lasombud' | 'moms_ombud'): ProbeClassification =>
      granted
        ? { status: 'granted', detail: `ombudsregister: ${key} aktiv ${today}` }
        : { status: 'denied', detail: `ombudsregister: ${key} saknas (roller: ${roles.join(', ') || 'inga'})` }
    return {
      result: {
        lasombud: describe(summary?.lasombud ?? false, 'lasombud'),
        momsOmbud: describe(summary?.moms_ombud ?? false, 'moms_ombud'),
      },
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
 * company's normalized 12-digit org number.
 */
export async function probeCompanyGrants(
  companyId: string,
  orgNumber: string,
  createdBy?: string
): Promise<GrantProbeResult> {
  const registry = await probeViaOmbudsregister(orgNumber)

  let lasombud: ProbeClassification
  let momsOmbud: ProbeClassification
  let source: GrantProbeResult['source']
  if (registry.result) {
    ;({ lasombud, momsOmbud } = registry.result)
    source = 'registry'
  } else {
    lasombud = await probeLasombud(orgNumber)
    momsOmbud = await probeMomsOmbud(orgNumber)
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
    lasombud: { status: lasombud.status, detail: lasombud.detail },
    momsOmbud: { status: momsOmbud.status, detail: momsOmbud.detail },
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
