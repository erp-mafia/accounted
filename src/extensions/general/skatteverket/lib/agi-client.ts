import type { SupabaseClient } from '@supabase/supabase-js'
import { skvRequest, skvRequestWithAuth, type SkvAuth } from './api-client'
import type { SkvAuditActor } from './audit'
import type {
  SkatteverketAGIErrorBody,
  SkatteverketAGIGranskningsunderlagResponse,
  SkatteverketAGIKontrollresultat,
  SkatteverketAGIKontrollsvar,
  SkatteverketAGIKvittenserResponse,
  SkatteverketAGIUnderlagResponse,
} from '../types'

/**
 * Skatteverket AGI (Arbetsgivardeklaration) client.
 *
 * Two RAMLs back this surface:
 *   • inlamning v1.7.7  : XML ingest + JSON status reads
 *     base: /arbetsgivardeklaration/inlamning/v1
 *   • hanteraredovisningsperiod v1.2.8: period lock + receipts
 *     base: /arbetsgivardeklaration/hanteraredovisningsperiod/v1
 *
 * Filing flow:
 *   1. POST /underlag                                        (XML body, returns inlamningId)
 *   2. GET  /underlag/{inlamningId}/kontrollresultat         (poll until status != PROCESSING)
 *   3a. POST /underlag/{inlamningId}/spara                   (move into Eget utrymme)
 *   3b. DELETE /underlag/{inlamningId}                       (abort if user wants to retry)
 *   4. POST /arbetsgivare/{x}/redovisningsperioder/{y}/skapaGranskningsunderlag?lasPeriod=true
 *      → returns Mina Sidor deep-link for BankID signing
 *   5. GET /arbetsgivare/{x}/redovisningsperioder/{y}/kvittenser   (after user signs)
 *
 * Optional period management on the hantera API:
 *   POST /arbetsgivare/{x}/redovisningsperioder/{y}/las     (lock)
 *   POST /arbetsgivare/{x}/redovisningsperioder/{y}/lasUpp  (unlock)
 *
 * Cleanup paths (both on the inlämning API, NOT hantera):
 *   DELETE /underlag/{inlamningId}:
 *     abort an unsaved underlag (use agiAvbrytUnderlag)
 *   DELETE /arbetsgivare/{x}/redovisningsperioder/{y}/inlamningar/{inlamningId}:
 *     remove a SAVED underlag from Eget utrymme (use agiTaBortSparadInlamning)
 *
 * Note: skvRequest already maps 401/403/429 to SkatteverketAuthError. AGI
 * 400/404/409 carry the SkatteverketAGIErrorBody envelope, which we surface
 * via Result.error so callers can render meddelandeTillAnvandare verbatim.
 *
 * Audit: every function passes its own endpoint label to the transport,
 * which writes one skatteverket_api_audit_log row per call. 'agi/submit' is
 * read by the migration-reset guard and must not change. Calls addressed by
 * inlamningId alone take the arbetsgivare and period as `scope` so the row
 * still says what it was about (null when the caller cannot know).
 */

/** What an inlamningId-addressed call was about, for its audit row. */
export interface AgiAuditScope {
  agRegistreradId: string | null
  redovisningsperiod: string | null
}

function periodScope(arbetsgivare: string, period: string) {
  return { agRegistreradId: arbetsgivare, redovisningsperiod: period }
}

/** The arbetsgivare and period a kontrollera payload names (spec v1.7 §7-8). */
function kontrolleraScope(payload: Record<string, unknown>): AgiAuditScope {
  const id = payload.agRegistreradId
  const period = payload.redovisningsPeriod
  return {
    agRegistreradId: typeof id === 'string' ? id : null,
    redovisningsperiod: typeof period === 'string' ? period : null,
  }
}

/** kontrollresultat / kontrollsvar status, for skv_status. */
function statusField(body: unknown): string | null {
  const status = (body as { status?: unknown } | null)?.status
  return typeof status === 'string' ? status : null
}

const DEFAULT_INLAMNING_BASE_URL =
  'https://api.test.skatteverket.se/arbetsgivardeklaration/inlamning/v1'
const DEFAULT_HANTERA_BASE_URL =
  'https://api.test.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1'

function getInlamningBaseUrl(): string {
  return process.env.SKATTEVERKET_AGD_INLAMNING_API_BASE_URL || DEFAULT_INLAMNING_BASE_URL
}

function getHanteraBaseUrl(): string {
  return process.env.SKATTEVERKET_AGD_PERIOD_API_BASE_URL || DEFAULT_HANTERA_BASE_URL
}

function periodPath(arbetsgivare: string, period: string): string {
  return `/arbetsgivare/${arbetsgivare}/redovisningsperioder/${period}`
}

interface Ok<T> { ok: true; status: number; data: T }
interface Err { ok: false; status: number; error: string; body?: SkatteverketAGIErrorBody }
type Result<T> = Ok<T> | Err

async function readErrorBody(response: Response): Promise<{ error: string; body?: SkatteverketAGIErrorBody }> {
  try {
    const body = (await response.json()) as SkatteverketAGIErrorBody
    if (body && typeof body.meddelandeTillAnvandare === 'string') {
      return { error: body.meddelandeTillAnvandare, body }
    }
    return { error: JSON.stringify(body) }
  } catch {
    return { error: `Skatteverket svarade med ${response.status}` }
  }
}

/**
 * POST /underlag: XML body, returns the new inlämningsId.
 *
 * The xml is whatever generateAGIXml() produced. We don't validate it
 * locally; Skatteverket replies 415 if the schema fails parsing, or 400
 * with felkod 38 if required fields are missing.
 */
export async function agiPostUnderlag(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  xml: string,
  scope: AgiAuditScope,
): Promise<Result<SkatteverketAGIUnderlagResponse>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    '/underlag',
    { endpoint: 'agi/submit', ...scope },
    xml,
    {
      baseUrl: getInlamningBaseUrl(),
      contentType: 'application/xml',
    },
  )

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = (await response.json()) as SkatteverketAGIUnderlagResponse
  return { ok: true, status: response.status, data }
}

/**
 * GET /underlag/{inlamningId}/kontrollresultat.
 *
 * Returns immediately with the current status. Callers should poll while
 * status === 'PROCESSING' (Skatteverket's typical processing time is sub-
 * second but the spec doesn't guarantee it).
 */
export async function agiGetKontrollresultat(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  inlamningId: number,
  scope: AgiAuditScope,
): Promise<Result<SkatteverketAGIKontrollresultat>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'GET',
    `/underlag/${inlamningId}/kontrollresultat`,
    { endpoint: 'agi/kontrollresultat', ...scope, skvStatusOf: statusField },
    undefined,
    { baseUrl: getInlamningBaseUrl() },
  )

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = (await response.json()) as SkatteverketAGIKontrollresultat
  return { ok: true, status: response.status, data }
}

/**
 * POST /underlag/{inlamningId}/spara: commit the underlag to Eget utrymme.
 *
 * Allowed even when kontrollresultat reports DONE_REJECTED: SKV will keep
 * the rejected underlag in Eget utrymme as a record. Mina Sidor does NOT
 * expose in-place editing of saved underlag; correcting a rejected AGI
 * means generating new XML (with the same FK570 specifikationsnummer per
 * employee) and resubmitting it as a rättelse via the same /underlag flow.
 * The current AGIPanel doesn't auto-spara on rejection; it surfaces the
 * findings and leaves recovery (re-generate + re-submit) to the user.
 *
 * Returns 400 felkod 20 if the underlag was already saved or had no
 * errors to fix.
 */
export async function agiSparaUnderlag(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  inlamningId: number,
  scope: AgiAuditScope,
): Promise<Result<unknown>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    `/underlag/${inlamningId}/spara`,
    { endpoint: 'agi/spara', ...scope },
    undefined,
    { baseUrl: getInlamningBaseUrl() },
  )

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = await response.json().catch(() => ({}))
  return { ok: true, status: response.status, data }
}

/**
 * DELETE /underlag/{inlamningId}: avbryt en inlämning som ännu inte sparats.
 *
 * Use this to discard an underlag whose kontrollresultat showed errors
 * before the user has clicked "spara". For *saved* underlag use
 * agiTaBortSparadInlamning() below.
 */
export async function agiAvbrytUnderlag(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  inlamningId: number,
  scope: AgiAuditScope,
): Promise<Result<unknown>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'DELETE',
    `/underlag/${inlamningId}`,
    { endpoint: 'agi/avbryt', ...scope },
    undefined,
    { baseUrl: getInlamningBaseUrl() },
  )

  if (response.status === 204) return { ok: true, status: 204, data: {} }
  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = await response.json().catch(() => ({}))
  return { ok: true, status: response.status, data }
}

/**
 * DELETE a saved underlag for an arbetsgivare + period. Distinct from
 * agiAvbrytUnderlag: this targets the saved copy in Eget utrymme.
 */
export async function agiTaBortSparadInlamning(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  arbetsgivare: string,
  period: string,
  inlamningId: number,
): Promise<Result<unknown>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'DELETE',
    `${periodPath(arbetsgivare, period)}/inlamningar/${inlamningId}`,
    { endpoint: 'agi/sparad/ta-bort', ...periodScope(arbetsgivare, period) },
    undefined,
    { baseUrl: getInlamningBaseUrl() },
  )

  if (response.status === 204) return { ok: true, status: 204, data: {} }
  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }
  return { ok: true, status: response.status, data: {} }
}

/**
 * POST /arbetsgivare/{x}/redovisningsperioder/{y}/skapaGranskningsunderlag.
 *
 * Returns a Mina Sidor deep-link the user opens in a new tab to sign with
 * BankID. `lasPeriod=true` locks the period for changes during signing:
 * recommended for the happy path. Caller can later POST .../las or .../lasUpp
 * on the hantera API to flip the lock without regenerating the granskning.
 */
export async function agiSkapaGranskningsunderlag(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  arbetsgivare: string,
  period: string,
  options: { lasPeriod?: boolean } = {},
): Promise<Result<SkatteverketAGIGranskningsunderlagResponse>> {
  const qs = options.lasPeriod ? '?lasPeriod=true' : ''
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    `${periodPath(arbetsgivare, period)}/skapaGranskningsunderlag${qs}`,
    {
      endpoint: 'agi/granskningsunderlag',
      ...periodScope(arbetsgivare, period),
      // 409 INCORRECT_DATA is an answer, not a failure (handled as data below).
      okStatuses: [409],
      skvStatusOf: (body) => {
        const tillstand = (body as { tillstand?: unknown } | null)?.tillstand
        return typeof tillstand === 'string' ? tillstand : null
      },
    },
    undefined,
    { baseUrl: getInlamningBaseUrl() },
  )

  // 409 INCORRECT_DATA returns the same shape as 200 (with a felrapport
  // link): surface it as data rather than an error so the UI can route the
  // user to fix the rejected underlag.
  if (response.status === 409) {
    const data = (await response.json()) as SkatteverketAGIGranskningsunderlagResponse
    return { ok: true, status: 409, data }
  }

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = (await response.json()) as SkatteverketAGIGranskningsunderlagResponse
  return { ok: true, status: response.status, data }
}

/**
 * GET /arbetsgivare/{x}/redovisningsperioder/{y}/kvittenser
 * (hanteraredovisningsperiod API).
 *
 * Returns an empty kvittenser array until the user has signed in Mina Sidor.
 * Once signed, each receipt carries uuidKvittens + signeradAv + signeradTid.
 *
 * Takes SkvAuth (not supabase+userId): kvittens polling is a background
 * read, so the crons can run it on system credentials when the company has
 * granted the lasombud behorighet. `actor` is who the audit row names: the
 * user who asked, or null for a system call no user started.
 */
export async function agiGetKvittenser(
  auth: SkvAuth,
  arbetsgivare: string,
  period: string,
  actor: SkvAuditActor,
): Promise<Result<SkatteverketAGIKvittenserResponse>> {
  const response = await skvRequestWithAuth(
    auth,
    'GET',
    `${periodPath(arbetsgivare, period)}/kvittenser`,
    { endpoint: 'kvittenser', ...actor, ...periodScope(arbetsgivare, period) },
    undefined,
    { baseUrl: getHanteraBaseUrl() },
  )

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = (await response.json()) as SkatteverketAGIKvittenserResponse
  return { ok: true, status: response.status, data }
}

/**
 * POST /arbetsgivare/{x}/redovisningsperioder/{y}/las (hantera API).
 * Locks the period for changes: typically called automatically by
 * skapaGranskningsunderlag with lasPeriod=true.
 */
export async function agiLasPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  arbetsgivare: string,
  period: string,
): Promise<Result<unknown>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    `${periodPath(arbetsgivare, period)}/las`,
    { endpoint: 'agi/las', ...periodScope(arbetsgivare, period) },
    undefined,
    { baseUrl: getHanteraBaseUrl() },
  )
  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }
  const data = await response.json().catch(() => ({}))
  return { ok: true, status: response.status, data }
}

/** POST /arbetsgivare/{x}/redovisningsperioder/{y}/lasUpp (hantera API). */
export async function agiLasUppPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  arbetsgivare: string,
  period: string,
): Promise<Result<unknown>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    `${periodPath(arbetsgivare, period)}/lasUpp`,
    { endpoint: 'agi/lasUpp', ...periodScope(arbetsgivare, period) },
    undefined,
    { baseUrl: getHanteraBaseUrl() },
  )
  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }
  const data = await response.json().catch(() => ({}))
  return { ok: true, status: response.status, data }
}

/**
 * POST /underlag/huvuduppgift/kontrollera: pre-flight validation of a single
 * HU as JSON without saving anything. Returns the kontrollsvar (OK / INFO /
 * ARENDE / STOPP / AVVISANDE) and a list of any fel that fired.
 *
 * Use this to surface validation errors per HU to the user before they
 * generate and submit a full XML underlag. The JSON property names follow
 * the v1.7 spec §7: see AGIKontrolleraHUSchema in
 * lib/salary/agi/kontrollera-schemas.ts for the validated shape.
 */
export async function agiKontrolleraHU(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  hu: Record<string, unknown>,
): Promise<Result<SkatteverketAGIKontrollsvar>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    '/underlag/huvuduppgift/kontrollera',
    { endpoint: 'agi.kontrollera.hu', ...kontrolleraScope(hu), skvStatusOf: statusField },
    hu,
    { baseUrl: getInlamningBaseUrl() },
  )

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = (await response.json()) as SkatteverketAGIKontrollsvar
  return { ok: true, status: response.status, data }
}

/**
 * POST /underlag/individuppgift/kontrollera: pre-flight validation of a
 * single IU as JSON without saving anything. JSON property names follow
 * the v1.7 spec §8: see AGIKontrolleraIUSchema in
 * lib/salary/agi/kontrollera-schemas.ts for the validated shape.
 */
export async function agiKontrolleraIU(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  iu: Record<string, unknown>,
): Promise<Result<SkatteverketAGIKontrollsvar>> {
  const response = await skvRequest(
    supabase,
    userId,
    companyId,
    'POST',
    '/underlag/individuppgift/kontrollera',
    { endpoint: 'agi.kontrollera.iu', ...kontrolleraScope(iu), skvStatusOf: statusField },
    iu,
    { baseUrl: getInlamningBaseUrl() },
  )

  if (!response.ok) {
    const { error, body } = await readErrorBody(response)
    return { ok: false, status: response.status, error, body }
  }

  const data = (await response.json()) as SkatteverketAGIKontrollsvar
  return { ok: true, status: response.status, data }
}
