import { z } from 'zod'
import { createLogger } from '@/lib/logger'
import { getSkatteverketEnvironment, skvRequestWithAuth, SkatteverketAuthError } from './api-client'
import type { SkvBehorighet } from './connection-store'

const log = createLogger('skatteverket-ombud-client')

/**
 * Client for Skatteverket's "Ombudshantering via API" v2 (scope `obr`).
 *
 * Source: Tjänstebeskrivning Ombudshantering via API v2.0, dokumentversion
 * 1.0 (2022-06-16), mirrored in dev_docs/skatteverket/ombudshantering/.
 * Base URI `{host}/behorighet/ombudshantering/v2`, JSON over HTTPS, headers
 * Accept + content-type application/json, Authorization Bearer, client_id,
 * client_secret, skv_client_correlation_id. Operations:
 *
 *   GET  /ombud/autentisieratOmbud?huvudman&roll&giltigFrom&giltigTom
 *        The huvudmän (companies/persons) the AUTHENTICATED ombud may
 *        represent, with role + validity. The ombud identity comes from the
 *        token: with a personal BankID token that is the person, with the
 *        system (CCG, organisationscertifikat) token it is Accounted's org
 *        number. Only the system identity answers "who granted Accounted".
 *   GET  /huvudman/autentisieradHuvudman?ombud&roll&giltigFrom&giltigTom
 *        The reverse view for a huvudman. Not used here.
 *   POST /ombud/autentisieratOmbud/huvudman/{huvudman}/djuplank/utseombud
 *        body { ombudsroller: [rollbeteckning...], giltigTom? }. Returns a
 *        deep link into the e-service "Ombud och behörigheter" with the roles
 *        pre-selected for the huvudman to sign with BankID. Valid three
 *        weeks from creation.
 *   GET  /roller?roll
 *        Role descriptions: rollbeteckning + rollbeskrivning.
 *
 * Every call here runs on the SYSTEM identity: the whole point is to ask
 * the register what companies granted Accounted, and to mint deep links
 * that name Accounted as the ombud.
 *
 * Two things the service description does not pin down, deliberately
 * handled tolerantly and logged so the first live call against the test
 * service settles them (see dev_docs/skatteverket/ombudshantering/README.md):
 *   - the JSON envelope of list responses (bare array vs. an object holding
 *     the list): both are accepted,
 *   - the rollbeteckning codes for "Juridiskt läsombud" and "Momsdeklaration,
 *     ombud": pin them via env once known; until then roles are classified
 *     by their rollbeskrivning text, which the register returns alongside.
 */

export const OMBUD_API_TEST_BASE_URL = 'https://api.test.skatteverket.se/behorighet/ombudshantering/v2'
export const OMBUD_API_PROD_BASE_URL = 'https://api.skatteverket.se/behorighet/ombudshantering/v2'

/** Deep links from /djuplank/utseombud are valid this long (service description 4.1.1). */
export const OMBUD_DEEP_LINK_VALIDITY_WEEKS = 3

export function getOmbudApiBaseUrl(): string {
  const override = process.env.SKATTEVERKET_OMBUD_API_BASE_URL
  if (override) return override.replace(/\/+$/, '')
  return getSkatteverketEnvironment() === 'prod' ? OMBUD_API_PROD_BASE_URL : OMBUD_API_TEST_BASE_URL
}

/** The behörigheter Accounted asks companies for, keyed as the connection row stores them. */
export const OMBUD_ROLE_KEYS: readonly SkvBehorighet[] = ['lasombud', 'moms_ombud'] as const

/**
 * Pinned rollbeteckning codes (exact match on `roll`). Unknown until read
 * from GET /roller in the test service; env-configurable so no deploy is
 * needed when Skatteverket confirms them.
 */
const ROLE_CODE_ENV: Record<SkvBehorighet, string> = {
  lasombud: 'SKATTEVERKET_OMBUD_ROLL_LASOMBUD',
  moms_ombud: 'SKATTEVERKET_OMBUD_ROLL_MOMS',
}

/**
 * Description-text fallback. Skatteverket's own labels in the e-service are
 * "Juridiskt läsombud" and "Momsdeklaration, ombud"; the register returns a
 * rollbeskrivning with every behörighetspost, so the text is available even
 * before the codes are pinned. Matching is exact on the whole label (case and
 * whitespace aside): "Momsdeklaration, deklarationsombud" is a broader role
 * and must never be read as "Momsdeklaration, ombud".
 */
const ROLE_DESCRIPTION_PATTERNS: Record<SkvBehorighet, RegExp> = {
  lasombud: /^juridiskt\s+l[äa]sombud$/i,
  moms_ombud: /^momsdeklaration,\s*ombud$/i,
}

export function getPinnedRoleCode(key: SkvBehorighet): string | null {
  const raw = process.env[ROLE_CODE_ENV[key]]?.trim()
  return raw ? raw : null
}

export interface OmbudRoleLike {
  roll: string
  rollbeskrivning?: string | null
}

/**
 * Which of Accounted's behörigheter a register role represents, or null
 * when it is some other role (companies hand out many; only two matter).
 * A pinned code wins over the text match, and a pinned code that does NOT
 * match disqualifies the text fallback for that key: once Emil has told us
 * the code, a differently-coded role with similar wording is a different role.
 */
export function classifyOmbudRole(role: OmbudRoleLike): SkvBehorighet | null {
  for (const key of OMBUD_ROLE_KEYS) {
    const pinned = getPinnedRoleCode(key)
    if (pinned) {
      if (role.roll === pinned) return key
      continue
    }
    if (role.rollbeskrivning && ROLE_DESCRIPTION_PATTERNS[key].test(role.rollbeskrivning)) return key
  }
  return null
}

// ── Wire schemas ─────────────────────────────────────────────────────

const BehorighetspostSchema = z.object({
  huvudman: z.string(),
  roll: z.string(),
  rollbeskrivning: z.string().nullish(),
  ombud: z.string().nullish(),
  giltigFrom: z.string(),
  giltigTom: z.string().nullish(),
})
export type Behorighetspost = z.infer<typeof BehorighetspostSchema>

const RollbeskrivningspostSchema = z.object({
  roll: z.string(),
  rollbeskrivning: z.string().nullish(),
})
export type Rollbeskrivningspost = z.infer<typeof RollbeskrivningspostSchema>

const DjuplankSchema = z.object({ djuplank: z.string().min(1) })

/**
 * Accept the list either bare or wrapped in an object under any of the names
 * the service description uses for it. Logged once per shape so the first
 * live call documents which one Skatteverket actually sends.
 */
function unwrapList(json: unknown, candidateKeys: string[], operation: string): unknown[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    for (const key of candidateKeys) {
      const value = (json as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        log.info('ombud list envelope observed', { operation, key })
        return value
      }
    }
  }
  throw new OmbudApiError(`Oväntat svarsformat från Ombudshantering (${operation}).`, 'OBR_BAD_RESPONSE')
}

export type OmbudApiErrorCode =
  | 'OBR_FORBIDDEN' // 401/403 for the system identity: scope/avtal missing, not a company-level fact
  | 'OBR_BAD_RESPONSE'
  | 'OBR_HTTP_ERROR'
  | 'OBR_ROLE_UNRESOLVED'

export class OmbudApiError extends Error {
  constructor(
    message: string,
    public readonly code: OmbudApiErrorCode,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'OmbudApiError'
  }
}

async function ombudRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  try {
    return await skvRequestWithAuth({ mode: 'system' }, method, path, body, {
      baseUrl: getOmbudApiBaseUrl(),
      accept: 'application/json',
    })
  } catch (err) {
    // api-client maps a system-mode 403 to OMBUD_GRANT_MISSING because on the
    // read services a 403 is "this company did not grant us". On the register
    // itself a 403 means Accounted may not call the service at all (scope or
    // avtal): a run-level condition that must never be recorded as a
    // company's grant state.
    if (err instanceof SkatteverketAuthError && err.code === 'OMBUD_GRANT_MISSING') {
      throw new OmbudApiError(
        'Ombudshantering-tjänsten nekade anropet: kontrollera att scopet obr och avtalet är på plats.',
        'OBR_FORBIDDEN',
        403
      )
    }
    throw err
  }
}

async function readJsonOrThrow(response: Response, operation: string): Promise<unknown> {
  if (response.ok) {
    return response.json().catch(() => {
      throw new OmbudApiError(`Ombudshantering svarade utan JSON (${operation}).`, 'OBR_BAD_RESPONSE', response.status)
    })
  }
  const text = await response.text().catch(() => '')
  throw new OmbudApiError(
    `Ombudshantering svarade ${response.status} (${operation})${text ? `: ${text.slice(0, 200)}` : ''}`,
    'OBR_HTTP_ERROR',
    response.status
  )
}

function buildQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

// ── Operations ───────────────────────────────────────────────────────

export type ListOmbudGrantsFilter = {
  /** 12-digit org/person number of one huvudman; omit for all of them. */
  huvudman?: string
  roll?: string
  giltigFrom?: string
  giltigTom?: string
}

/**
 * GET /ombud/autentisieratOmbud: every behörighetspost where the system
 * identity (Accounted's org number) is the ombud. Skatteverket returns
 * current and FUTURE grants; use {@link isGrantActive} before trusting one.
 *
 * A 404 is "wrong URI" per the service description (4.7), yet its 1..*
 * multiplicity for the list leaves an empty register indistinguishable from
 * it. Default: a 404 throws like any other HTTP error, so a single-company
 * probe falls back to the read-service probes instead of recording a denial
 * on a transport fault. Only the sync cron opts into `emptyOn404`, and it
 * pairs that with its empty-register guard (a zero result downgrades nothing).
 */
export async function listOmbudGrants(
  filter: ListOmbudGrantsFilter = {},
  options: { emptyOn404?: boolean } = {}
): Promise<Behorighetspost[]> {
  const response = await ombudRequest('GET', `/ombud/autentisieratOmbud${buildQuery(filter)}`)
  if (response.status === 404 && options.emptyOn404) return []
  const json = await readJsonOrThrow(response, 'ombud/autentisieratOmbud')
  const rows = unwrapList(json, ['behorighetsposter', 'Behorighetsposter', 'behorigheter'], 'ombud/autentisieratOmbud')
  const parsed = z.array(BehorighetspostSchema).safeParse(rows)
  if (!parsed.success) {
    throw new OmbudApiError('Behörighetsposter från Ombudshantering kunde inte tolkas.', 'OBR_BAD_RESPONSE')
  }
  return parsed.data
}

/** GET /roller: all rollbeteckningar with descriptions (or one, when filtered). */
export async function getOmbudRoleDescriptions(roll?: string): Promise<Rollbeskrivningspost[]> {
  const response = await ombudRequest('GET', `/roller${buildQuery({ roll })}`)
  const json = await readJsonOrThrow(response, 'roller')
  const rows = unwrapList(json, ['rollbeskrivningsposter', 'Rollbeskrivningsposter', 'roller'], 'roller')
  const parsed = z.array(RollbeskrivningspostSchema).safeParse(rows)
  if (!parsed.success) {
    throw new OmbudApiError('Rollbeskrivningar från Ombudshantering kunde inte tolkas.', 'OBR_BAD_RESPONSE')
  }
  return parsed.data
}

/**
 * The rollbeteckning codes to put in a deep link: pinned env values first,
 * otherwise resolved from GET /roller by description. Throws when a key
 * cannot be resolved rather than minting a link with a guessed role.
 */
export async function resolveOmbudRoleCodes(keys: readonly SkvBehorighet[]): Promise<Record<SkvBehorighet, string>> {
  const resolved: Partial<Record<SkvBehorighet, string>> = {}
  const missing: SkvBehorighet[] = []
  for (const key of keys) {
    const pinned = getPinnedRoleCode(key)
    if (pinned) resolved[key] = pinned
    else missing.push(key)
  }
  if (missing.length > 0) {
    const roles = await getOmbudRoleDescriptions()
    for (const key of missing) {
      const hit = roles.find((role) => classifyOmbudRole(role) === key)
      if (hit) resolved[key] = hit.roll
    }
    const unresolved = missing.filter((key) => !resolved[key])
    if (unresolved.length > 0) {
      log.warn('ombud role codes unresolved from /roller', {
        unresolved,
        available: roles.map((r) => `${r.roll}=${r.rollbeskrivning ?? ''}`),
      })
      throw new OmbudApiError(
        `Rollkod saknas för ${unresolved.join(', ')}: sätt ${unresolved
          .map((key) => ROLE_CODE_ENV[key])
          .join(' och ')} efter uppslag i GET /roller.`,
        'OBR_ROLE_UNRESOLVED'
      )
    }
  }
  return resolved as Record<SkvBehorighet, string>
}

export interface UtseOmbudDeepLink {
  djuplank: string
  /** rollbeteckning codes the link pre-selects, keyed by behörighet. */
  roller: Record<SkvBehorighet, string>
  /** yyyy-mm-dd when the link stops working (three weeks from creation). */
  expiresOn: string
}

/**
 * POST .../huvudman/{huvudman}/djuplank/utseombud on the system identity:
 * a link the company opens to appoint Accounted as ombud with the given
 * roles pre-selected, then signs in the e-service with BankID.
 */
export async function createUtseOmbudDeepLink(
  huvudman: string,
  keys: readonly SkvBehorighet[] = OMBUD_ROLE_KEYS,
  giltigTom?: string,
  now: Date = new Date()
): Promise<UtseOmbudDeepLink> {
  const roller = await resolveOmbudRoleCodes(keys)
  const body: { ombudsroller: string[]; giltigTom?: string } = {
    ombudsroller: keys.map((key) => roller[key]),
  }
  if (giltigTom) body.giltigTom = giltigTom
  const response = await ombudRequest(
    'POST',
    `/ombud/autentisieratOmbud/huvudman/${encodeURIComponent(huvudman)}/djuplank/utseombud`,
    body
  )
  const json = await readJsonOrThrow(response, 'djuplank/utseombud')
  const parsed = DjuplankSchema.safeParse(json)
  if (!parsed.success) {
    throw new OmbudApiError('Djuplänken från Ombudshantering kunde inte tolkas.', 'OBR_BAD_RESPONSE')
  }
  const expires = new Date(now.getTime() + OMBUD_DEEP_LINK_VALIDITY_WEEKS * 7 * 24 * 60 * 60 * 1000)
  return { djuplank: parsed.data.djuplank, roller, expiresOn: expires.toISOString().slice(0, 10) }
}

// ── Pure helpers over behörighetsposter ──────────────────────────────

/** yyyy-mm-dd for the given instant, in UTC (Skatteverket dates are date-only). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * A grant counts today when giltigFrom is today or earlier and giltigTom is
 * empty (tillsvidare) or today or later. Date-only strings compare
 * lexically, which is exactly the yyyy-mm-dd contract.
 */
export function isGrantActive(post: Pick<Behorighetspost, 'giltigFrom' | 'giltigTom'>, today: string): boolean {
  if (!post.giltigFrom || post.giltigFrom > today) return false
  if (post.giltigTom && post.giltigTom < today) return false
  return true
}

/**
 * Register identities arrive as 12 digits, sometimes with a separator
 * (string 12..13 per the service description). Reduce to 12 digits or null.
 */
export function normalizeHuvudman(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  return /^\d{12}$/.test(digits) ? digits : null
}

export interface HuvudmanGrantSummary {
  huvudman: string
  lasombud: boolean
  moms_ombud: boolean
  /** Every rollbeteckning seen for this huvudman, active or not: diagnostics. */
  roles: string[]
  /**
   * True when at least one post (active or not) classified as one of
   * Accounted's behörigheter. False with a non-empty `roles` means the
   * register lists roles we cannot name: a code-pinning problem, not a
   * company decision.
   */
  recognized: boolean
}

/**
 * Collapse behörighetsposter into one row per huvudman saying which of
 * Accounted's two behörigheter are active today. Roles outside the two are
 * kept in `roles` for the probe detail but decide nothing.
 */
export function summarizeGrants(posts: Behorighetspost[], today: string): Map<string, HuvudmanGrantSummary> {
  const out = new Map<string, HuvudmanGrantSummary>()
  for (const post of posts) {
    const huvudman = normalizeHuvudman(post.huvudman)
    if (!huvudman) {
      log.warn('behorighetspost with unparsable huvudman skipped', { huvudman: post.huvudman, roll: post.roll })
      continue
    }
    let row = out.get(huvudman)
    if (!row) {
      row = { huvudman, lasombud: false, moms_ombud: false, roles: [], recognized: false }
      out.set(huvudman, row)
    }
    if (!row.roles.includes(post.roll)) row.roles.push(post.roll)
    const key = classifyOmbudRole(post)
    if (!key) continue
    row.recognized = true
    if (isGrantActive(post, today)) row[key] = true
  }
  return out
}
