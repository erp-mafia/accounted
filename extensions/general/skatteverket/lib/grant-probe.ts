import { skvRequestWithAuth, SkatteverketAuthError } from './api-client'
import { getSkattekontoBaseUrl } from './skattekonto-client'
import { recordProbeResult, type GrantStatus, type SkvCompanyConnection } from './connection-store'
import { currentSkvEnvironment } from './resolve-auth'
import { createLogger } from '@/lib/logger'

const log = createLogger('skatteverket-grant-probe')

/**
 * Behorighet verification probes.
 *
 * After the user grants Accounted's org number a behorighet in Skatteverket's
 * Ombud och behorigheter e-service, nothing tells us: there is no callback.
 * The probe makes one cheap read per behorighet with SYSTEM credentials and
 * classifies the outcome:
 *
 *   lasombud   : GET skattekonto saldo for the company's org number.
 *                200 -> granted; felkod 3 (no skattekonto registered) also
 *                proves authorization passed -> granted-with-note;
 *                OMBUD_GRANT_MISSING (403) -> denied; anything transient
 *                (5xx, timeout, rate limit) -> error, which never downgrades
 *                a previously granted state (connection-store rule).
 *   moms_ombud : GET moms /utkast for the current period. 200 or 404 (no
 *                draft exists, but the gateway authorized us) -> granted;
 *                OMBUD_GRANT_MISSING -> denied.
 *
 * The classification heuristics live here, in one file, because they are
 * assumptions until validated against real sandbox 403 bodies (Phase 2 of
 * the rollout): expected churn stays contained.
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

export interface GrantProbeResult {
  connection: SkvCompanyConnection | null
  lasombud: ProbeClassification
  momsOmbud: ProbeClassification
}

/**
 * Run both behorighet probes for a company and persist the outcome.
 * The caller has already verified role + capability and resolved the
 * company's normalized 12-digit org number.
 */
export async function probeCompanyGrants(
  companyId: string,
  orgNumber: string,
  createdBy?: string
): Promise<GrantProbeResult> {
  const [lasombud, momsOmbud] = [await probeLasombud(orgNumber), await probeMomsOmbud(orgNumber)]

  log.info('grant probe completed', {
    companyId,
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

  return { connection, lasombud, momsOmbud }
}
