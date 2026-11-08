import { z } from 'zod'
import { createLogger } from '@/lib/logger'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getSkatteverketEnvironment, skvRequestWithAuth, SkatteverketAuthError, type SkvAudit } from './api-client'
import type { SkvAuditActor } from './audit'
import type { SkvBehorighet } from './connection-store'

const log = createLogger('skatteverket-ombud-client')

/**
 * Client for Skatteverket's "Ombudshantering via API" v2 (scope `obr`).
 *
 * Source: Tjänstebeskrivning Ombudshantering via API v2.0, dokumentversion
 * 1.0 (2022-06-16).
 * Base URI `{host}/behorighet/ombudshantering/v2`, JSON over HTTPS, headers
 * Accept + content-type application/json (on every call: a GET without
 * Content-Type is answered 400), Authorization Bearer, client_id,
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
 * The first live calls against the test service (2026-11-03) settled what
 * the service description left open: both list operations answer with a
 * bare JSON array (an enveloped list is still accepted), and the role codes
 * are the ones in OMBUD_ROLES below.
 */

export const OMBUD_API_TEST_BASE_URL = 'https://api.test.skatteverket.se/behorighet/ombudshantering/v2'
export const OMBUD_API_PROD_BASE_URL = 'https://api.skatteverket.se/behorighet/ombudshantering/v2'

/**
 * The fallback beside the deep link: Skatteverket's guide "Utse ombud för ett
 * företag", which lists who can use the e-service Ombud och behörigheter
 * (enskilda firmor, aktiebolag, handelsbolag, kommanditbolag, ekonomiska
 * föreningar) and links into it. Not
 * skatteverket.se/ombud: that lands on "Ombud för en privatperson" and reads
 * as if the ombud were for the person signing, not for the company
 * (both pages read 2026-11-08).
 */
export const OMBUD_COMPANY_GUIDE_URL =
  'https://www.skatteverket.se/foretag/drivaforetag/ombudforettforetag/utseombudforettforetag.4.5a85666214dbad743ff1158c.html'

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
 * The register role (rollbeteckning) behind each behörighet, with
 * Skatteverket's name for it (the role the company picks in the e-service
 * "Ombud och behörigheter"; the settings page shows it from the
 * system_behorighet_* messages). Read from GET /roller in the test service on
 * 2026-11-03, where no role called "Juridiskt läsombud" exists.
 *   lasombud    skol, "Skattekonto, bara läsbehörighet": the skattekonto
 *               saldo and transaktioner reads. A huvudman that gave only
 *               momsdeklaration_ombud answers the saldo read with 403
 *               felkod 6 "Auktorisation saknas".
 *   moms_ombud  momsdeklaration_ombud, "Momsdeklaration, ombud"; not the
 *               broader "Momsdeklaration, deklarationsombud".
 * Matching is on the code alone, never on the description text. The env
 * var overrides a code without a deploy, should production differ.
 */
export const OMBUD_ROLES: Record<SkvBehorighet, { code: string; env: string }> = {
  lasombud: { code: 'skol', env: 'SKATTEVERKET_OMBUD_ROLL_LASOMBUD' },
  moms_ombud: { code: 'momsdeklaration_ombud', env: 'SKATTEVERKET_OMBUD_ROLL_MOMS' },
}

/** The rollbeteckning for a behörighet: the env override, else the register's code. */
export function getOmbudRoleCode(key: SkvBehorighet): string {
  return process.env[OMBUD_ROLES[key].env]?.trim() || OMBUD_ROLES[key].code
}

/**
 * Which of Accounted's behörigheter a register role represents, or null
 * when it is some other role (companies hand out many; only two matter).
 */
export function classifyOmbudRole(role: Rollbeskrivningspost): SkvBehorighet | null {
  return OMBUD_ROLE_KEYS.find((key) => role.roll === getOmbudRoleCode(key)) ?? null
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

/**
 * Hosts a deep link may point at. The settings page navigates the browser
 * to this URL, so the register's answer is not trusted blindly: only HTTPS
 * on skatteverket.se (or a subdomain) passes. Test service links come from
 * the same domain family.
 */
export function isAllowedDeepLinkUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === 'skatteverket.se' || host.endsWith('.skatteverket.se')
}

const DjuplankSchema = z.object({
  djuplank: z.string().min(1).refine(isAllowedDeepLinkUrl, 'djuplank must be an https skatteverket.se URL'),
})

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

/**
 * Whose register call this is. A company's own (the grant lookup for its org
 * number, its deep link) is audited against that company; 'ombud_register'
 * marks Accounted's own calls as ombud that belong to no company (the
 * whole-register listing, /roller): the transport logs those instead, since
 * the audit table is per company.
 */
export type OmbudCaller = SkvAuditActor | 'ombud_register'

function ombudAudit(caller: OmbudCaller, endpoint: string, huvudman?: string): SkvAudit {
  if (caller === 'ombud_register') return { unaudited: 'ombud_register', operation: endpoint }
  // Every company-scoped register call reads its answer with readJsonOrThrow,
  // so a 2xx without JSON is the caller's error and must not be recorded 'ok'.
  return { endpoint, ...caller, agRegistreradId: huvudman ?? null, expectJson: true }
}

async function ombudRequest(method: 'GET' | 'POST', path: string, audit: SkvAudit, body?: unknown): Promise<Response> {
  try {
    return await skvRequestWithAuth({ mode: 'system' }, method, path, audit, body, {
      baseUrl: getOmbudApiBaseUrl(),
      accept: 'application/json',
      // Named, so it goes on the GETs too: the register answers 400
      // "Required header 'Content-Type' not specified" without it.
      contentType: 'application/json',
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
  filter: ListOmbudGrantsFilter,
  caller: OmbudCaller,
  options: { emptyOn404?: boolean } = {}
): Promise<Behorighetspost[]> {
  const response = await ombudRequest(
    'GET',
    `/ombud/autentisieratOmbud${buildQuery(filter)}`,
    ombudAudit(caller, 'ombud/autentisieratOmbud', filter.huvudman)
  )
  if (response.status === 404 && options.emptyOn404) return []
  const json = await readJsonOrThrow(response, 'ombud/autentisieratOmbud')
  const rows = unwrapList(json, ['behorighetsposter', 'Behorighetsposter', 'behorigheter'], 'ombud/autentisieratOmbud')
  const parsed = z.array(BehorighetspostSchema).safeParse(rows)
  if (!parsed.success) {
    throw new OmbudApiError('Behörighetsposter från Ombudshantering kunde inte tolkas.', 'OBR_BAD_RESPONSE')
  }
  return parsed.data
}

/**
 * GET /roller: all rollbeteckningar with descriptions (or one, when filtered).
 * A lookup about the register itself, never about a company: not audited in
 * the company table (see OmbudCaller). Diagnostics only (the smoke script):
 * the codes Accounted asks for are in OMBUD_ROLES.
 */
export async function getOmbudRoleDescriptions(roll?: string): Promise<Rollbeskrivningspost[]> {
  const response = await ombudRequest('GET', `/roller${buildQuery({ roll })}`, ombudAudit('ombud_register', 'roller'))
  const json = await readJsonOrThrow(response, 'roller')
  const rows = unwrapList(json, ['rollbeskrivningsposter', 'Rollbeskrivningsposter', 'roller'], 'roller')
  const parsed = z.array(RollbeskrivningspostSchema).safeParse(rows)
  if (!parsed.success) {
    throw new OmbudApiError('Rollbeskrivningar från Ombudshantering kunde inte tolkas.', 'OBR_BAD_RESPONSE')
  }
  return parsed.data
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
  actor: SkvAuditActor,
  keys: readonly SkvBehorighet[] = OMBUD_ROLE_KEYS,
  giltigTom?: string,
  now: Date = new Date()
): Promise<UtseOmbudDeepLink> {
  const ombudsroller = keys.map(getOmbudRoleCode)
  const roller = Object.fromEntries(keys.map((key, i) => [key, ombudsroller[i]])) as Record<SkvBehorighet, string>
  const body: { ombudsroller: string[]; giltigTom?: string } = { ombudsroller }
  if (giltigTom) body.giltigTom = giltigTom
  const response = await ombudRequest(
    'POST',
    `/ombud/autentisieratOmbud/huvudman/${encodeURIComponent(huvudman)}/djuplank/utseombud`,
    ombudAudit(actor, 'system-connection/deeplink', huvudman),
    body
  )
  const json = await readJsonOrThrow(response, 'djuplank/utseombud')
  const parsed = DjuplankSchema.safeParse(json)
  if (!parsed.success) {
    log.warn('deep link rejected', { issues: parsed.error.issues.map((i) => i.message) })
    throw new OmbudApiError('Djuplänken från Ombudshantering kunde inte tolkas.', 'OBR_BAD_RESPONSE')
  }
  // Shown to the user as a date: counted from the Swedish calendar day.
  const expiresOn = addDaysIso(todayIsoStockholm(now), OMBUD_DEEP_LINK_VALIDITY_WEEKS * 7)
  return { djuplank: parsed.data.djuplank, roller, expiresOn }
}

// ── Pure helpers over behörighetsposter ──────────────────────────────

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
   * register lists roles we cannot name: a wrong role code (OMBUD_ROLES or
   * its env override), not a company decision.
   */
  recognized: boolean
  /**
   * Per behörighet, the latest giltigFrom (yyyy-mm-dd) among its ACTIVE
   * posts: when the newest standing grant was signed. Null when none is
   * active. Read through grantCountsFor, never on its own.
   */
  signedFrom: Record<SkvBehorighet, string | null>
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
      row = {
        huvudman,
        lasombud: false,
        moms_ombud: false,
        roles: [],
        recognized: false,
        signedFrom: { lasombud: null, moms_ombud: null },
      }
      out.set(huvudman, row)
    }
    if (!row.roles.includes(post.roll)) row.roles.push(post.roll)
    const key = classifyOmbudRole(post)
    if (!key) continue
    row.recognized = true
    if (isGrantActive(post, today)) {
      row[key] = true
      const from = post.giltigFrom.slice(0, 10)
      const latest = row.signedFrom[key]
      if (!latest || from > latest) row.signedFrom[key] = from
    }
  }
  return out
}

/**
 * Whether a register grant counts for a company that opted in on `optInDay`
 * (yyyy-mm-dd, the day its connection row was created for this org number).
 *
 * Org-number proof (founder decision 2026-10-02): a grant counts only when it
 * was signed on or after the company's own opt-in. Org numbers are public and
 * any tenant can type one; a grant signed BEFORE the tenant opted in was given
 * to Accounted for someone else's use of the number (a former customer who
 * left without withdrawing it), and must not be inherited. A grant signed
 * after the opt-in was signed by a firmatecknare for this very connection.
 */
export function grantCountsFor(
  summary: HuvudmanGrantSummary | undefined,
  key: SkvBehorighet,
  optInDay: string
): boolean {
  const from = summary?.signedFrom[key]
  return Boolean(summary?.[key] && from && from >= optInDay)
}

/** True when the behörighet is active at Skatteverket but was signed before the opt-in. */
export function grantPredatesOptIn(
  summary: HuvudmanGrantSummary | undefined,
  key: SkvBehorighet,
  optInDay: string
): boolean {
  return Boolean(summary?.[key]) && !grantCountsFor(summary, key, optInDay)
}
