/**
 * Submission orchestration for digital inlämning av årsredovisning.
 *
 * Flow (GUIDE §4.2/§5.3): skapa-inlamningtoken → [avtalstext gate] →
 * kontrollera → inlamning till eget utrymme → handelseprenumeration. The
 * undertecknare then signs the fastställelseintyg with e-legitimation AT
 * Bolagsverket (never in our app); webhooks/polling drive the status from
 * there: uploaded → inkommen → (förelagd ↔ komplettering)* →
 * registrerad | avslutad.
 *
 * Personnummer are transient: used for the API calls, persisted only as
 * company-salted SHA-256 hashes.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument, embedKontrollsumma } from '@/lib/bokslut/ixbrl/document/k2-document'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import { BolagsverketClient } from './client'
import type { ExtensionLogger } from '@/lib/extensions/types'
import type {
  ArsredovisningSubmission,
  HandelseMeddelande,
  KontrolleraUtfall,
  SubmissionStatus,
} from '../types'

/**
 * Domain error carrying a structured-error registry code
 * (lib/errors/structured-errors.ts). index.ts maps it through
 * errorResponseFromCode for the canonical envelope.
 */
export class BolagsverketSubmissionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BolagsverketSubmissionError'
  }
}

/** Statuses that mean "Bolagsverket currently holds an open filing for this period". */
export const ACTIVE_SUBMISSION_STATUSES = [
  'uploaded',
  'inkommen',
  'forelagd',
  'komplettering',
] as const

export function hashPnr(companyId: string, pnr: string): string {
  return createHash('sha256').update(`${companyId}:${pnr.replace(/\D/g, '')}`).digest('hex')
}

/** Normalize to the 10-digit orgnr the API expects (no dash, no century). */
export function normalizeOrgnr(orgNumber: string): string {
  const digits = orgNumber.replace(/\D/g, '')
  return digits.length === 12 ? digits.slice(2) : digits
}

/**
 * SECURITY: `avsandarePnr` and `undertecknare.pnr` are plaintext personnummer,
 * needed only for the Bolagsverket API calls. They must NEVER reach a log sink:
 * log structured fields (companyId, fiscalPeriodId, submissionId) and never
 * the params object itself. At rest only company-salted SHA-256 hashes are
 * stored (see hashPnr).
 */
export interface SubmitParams {
  companyId: string
  userId: string
  fiscalPeriodId: string
  /** Avsändarens personnummer (12 siffror): required by skapa-inlamningtoken. */
  avsandarePnr: string
  /** Undertecknare of fastställelseintyget. */
  undertecknare: {
    pnr: string
    fornamn: string
    efternamn: string
    roll: string
    epost: string
  }
  kvittensEpost?: string[]
  proposedDividend?: number
  /** User accepted the current avtalstext (avtalstextAndrad value). */
  acceptedAvtalstextAndrad?: string
  /** Upload even when kontrollera returns warn-level utfall (GUIDE §4.2.2). */
  ignoreWarnings?: boolean
}

export type SubmitResult =
  | { outcome: 'avtal_required'; avtalstext: string; avtalstextAndrad: string }
  | { outcome: 'preflight_failed'; issues: ReturnType<typeof runPreflightChecks>['issues'] }
  | {
      outcome: 'kontrollera_stopped'
      submissionId: string
      utfall: KontrolleraUtfall[]
    }
  | {
      outcome: 'uploaded'
      submissionId: string
      idnummer: string
      sha256: string
      url: string
      utfall: KontrolleraUtfall[]
    }

interface ServiceDeps {
  supabase: SupabaseClient
  client: BolagsverketClient
  /** Absolute base URL of this install, for the webhook subscription. */
  appUrl: string
  /** Extension logger: non-fatal failures must be visible, never swallowed. */
  log: ExtensionLogger
}

/** Best-effort: persist a failure on the submission row so it is visible. */
async function markSubmissionError(
  supabase: SupabaseClient,
  log: ExtensionLogger,
  submissionId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const { error } = await supabase
    .from('arsredovisning_submissions')
    .update({ status: 'error', error_message: message.slice(0, 2_000) })
    .eq('id', submissionId)
  if (error) {
    log.error('could not mark submission as error', { submissionId, dbError: error.message })
  }
}

async function getOrgnr(supabase: SupabaseClient, companyId: string): Promise<string> {
  const { data } = await supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  const orgNumber = (data as { org_number?: string } | null)?.org_number
  if (!orgNumber) throw new Error('Organisationsnummer saknas i företagsinställningarna.')
  return normalizeOrgnr(orgNumber)
}

export async function submitArsredovisning(
  deps: ServiceDeps,
  params: SubmitParams,
): Promise<SubmitResult> {
  const { supabase, client, log } = deps
  const orgnr = await getOrgnr(supabase, params.companyId)

  // 0. Double-submission guard: once an upload reached Bolagsverket, a retry
  //    would file a second handling (and store a second audit document).
  //    Refuse while a submission for this period is still open with the
  //    authority. Rows in draft/kontrollerad/error/registrerad/avslutad do
  //    not block: retries after failure create a fresh row.
  const { data: activeRows } = await supabase
    .from('arsredovisning_submissions')
    .select('id, status')
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .in('status', [...ACTIVE_SUBMISSION_STATUSES])
    .limit(1)
  const active = (activeRows as Array<{ id: string; status: string }> | null)?.[0]
  if (active) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_SUBMISSION_EXISTS',
      `An active submission (${active.status}) already exists for this fiscal period.`,
      { submission_id: active.id, status: active.status },
    )
  }

  // 1. Token (also carries the avtalstext we must gate on).
  const token = await client.createInlamningToken(params.avsandarePnr, orgnr)

  // 2. Avtalstext gate (GUIDE §4.2): the user must have accepted THIS version
  //    of the text for THIS company before kontrollera/inlämning may run.
  const { data: acceptance } = await supabase
    .from('bolagsverket_avtal_acceptances')
    .select('id')
    .eq('company_id', params.companyId)
    .eq('user_id', params.userId)
    .eq('avtalstext_andrad', token.avtalstextAndrad)
    .maybeSingle()
  const acceptedNow = params.acceptedAvtalstextAndrad === token.avtalstextAndrad
  if (!acceptance && !acceptedNow) {
    return {
      outcome: 'avtal_required',
      avtalstext: token.avtalstext,
      avtalstextAndrad: token.avtalstextAndrad,
    }
  }
  if (!acceptance && acceptedNow) {
    await supabase.from('bolagsverket_avtal_acceptances').insert({
      company_id: params.companyId,
      user_id: params.userId,
      avtalstext_andrad: token.avtalstextAndrad,
    })
  }

  // 3. Generate the iXBRL + local pre-flight (layer 1): cheaper than a
  //    kontrollera round-trip and catches data problems with better messages.
  const input = await buildIxbrlInput(supabase, params.companyId, params.fiscalPeriodId, {
    proposedDividend: params.proposedDividend,
    undertecknare: {
      firstName: params.undertecknare.fornamn,
      lastName: params.undertecknare.efternamn,
      role: params.undertecknare.roll,
    },
  })
  const preflight = runPreflightChecks(input)
  if (!preflight.ok) {
    return { outcome: 'preflight_failed', issues: preflight.issues }
  }
  let { xhtml } = generateK2IxbrlDocument(input)

  // 4. Kontrollsumma (TA §4.5, recommended): tag the checksum into <head> so
  //    the kvittens email carries a verifiable hash. Non-fatal on failure.
  let kontrollsumma: string | null = null
  try {
    const checksumToken = await client.createChecksumToken(params.avsandarePnr, orgnr)
    const checksum = await client.createChecksum(
      checksumToken.token,
      Buffer.from(xhtml, 'utf8').toString('base64'),
    )
    kontrollsumma = checksum.kontrollsumma
    xhtml = embedKontrollsumma(xhtml, checksum.kontrollsumma, checksum.algoritm)
  } catch (err) {
    kontrollsumma = null
    log.warn('kontrollsumma generation failed: continuing without embedded checksum', {
      companyId: params.companyId,
      fiscalPeriodId: params.fiscalPeriodId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const fileBase64 = Buffer.from(xhtml, 'utf8').toString('base64')

  // 5. Create the submission row (draft) before talking to Bolagsverket so
  //    every attempt is traceable.
  const { data: submissionRow, error: insertError } = await supabase
    .from('arsredovisning_submissions')
    .insert({
      company_id: params.companyId,
      user_id: params.userId,
      fiscal_period_id: params.fiscalPeriodId,
      handling_typ: 'arsredovisning_komplett',
      taxonomy_version: '2024-09-12',
      entry_point: input.entryPointId,
      environment: client.environment,
      status: 'draft',
      undertecknare_namn: `${params.undertecknare.fornamn} ${params.undertecknare.efternamn}`,
      undertecknare_epost: params.undertecknare.epost,
      undertecknare_pnr_hash: hashPnr(params.companyId, params.undertecknare.pnr),
      avsandare_pnr_hash: hashPnr(params.companyId, params.avsandarePnr),
      kontrollsumma,
    })
    .select('id')
    .single()
  if (insertError || !submissionRow) {
    throw new Error(`Kunde inte spara inlämningsförsöket: ${insertError?.message ?? 'okänt fel'}`)
  }
  const submissionId = (submissionRow as { id: string }).id

  // Steps 6-8 talk to Bolagsverket with a persisted row in play. Any failure
  // here must flip the row to status='error' with the message: otherwise it
  // sits in draft/kontrollerad forever and the failed attempt is invisible.
  let svar: Awaited<ReturnType<BolagsverketClient['lamnaIn']>>
  let utfall: KontrolleraUtfall[]
  try {
    // 6. Kontrollera (layer 3): always run; surface utfall to the user.
    const kontrollSvar = await client.kontrollera(token.token, fileBase64, 'arsredovisning_komplett')
    utfall = kontrollSvar.utfall ?? []
    await supabase
      .from('arsredovisning_submissions')
      .update({ status: 'kontrollerad', kontrollera_utfall: utfall })
      .eq('id', submissionId)
    const hasBlocking = utfall.some((item) => item.typ?.toLowerCase() === 'error')
    if (utfall.length > 0 && (hasBlocking || !params.ignoreWarnings)) {
      return { outcome: 'kontrollera_stopped', submissionId, utfall }
    }

    // 7. Store the exact uploaded bytes as räkenskapsinformation (7-year
    //    retention, Accounting Guard Rail #7) BEFORE upload.
    let dokumentId: string | null = null
    try {
      const buffer = Buffer.from(xhtml, 'utf8')
      const doc = await uploadDocument(
        supabase,
        params.userId,
        params.companyId,
        {
          name: `arsredovisning-${input.period.end}-inlamnad.xhtml`,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
          type: 'application/xhtml+xml',
        },
        { upload_source: 'system' },
      )
      dokumentId = doc.id
    } catch (err) {
      // Storage failure must not block the filing, but it MUST be visible:
      // without the stored bytes the legally-filed document is not
      // reproducible from our archive (Guard Rail #7).
      dokumentId = null
      const message = err instanceof Error ? err.message : String(err)
      log.error('failed to archive the filed .xhtml as räkenskapsinformation', {
        submissionId,
        companyId: params.companyId,
        error: message,
      })
      await supabase
        .from('arsredovisning_submissions')
        .update({ error_message: `Dokumentarkivering misslyckades: ${message}`.slice(0, 2_000) })
        .eq('id', submissionId)
    }

    // 8. Lämna in till eget utrymme.
    svar = await client.lamnaIn(token.token, {
      undertecknare: params.undertecknare.pnr,
      epostadresser: [params.undertecknare.epost],
      kvittensepostadresser: params.kvittensEpost,
      fileBase64,
      typ: 'arsredovisning_komplett',
    })

    const { error: uploadUpdateError } = await supabase
      .from('arsredovisning_submissions')
      .update({
        status: 'uploaded',
        idnummer: svar.handlingsinfo.idnummer,
        sha256_checksumma: svar.handlingsinfo.sha256checksumma,
        bolagsverket_url: svar.url,
        dokument_id: dokumentId,
        uploaded_at: new Date().toISOString(),
      })
      .eq('id', submissionId)
    if (uploadUpdateError) {
      log.error('failed to persist uploaded state after successful inlämning', {
        submissionId,
        idnummer: svar.handlingsinfo.idnummer,
        dbError: uploadUpdateError.message,
      })
    }
  } catch (err) {
    await markSubmissionError(supabase, log, submissionId, err)
    throw err // preserved for the route's error mapping (5xx / upstream status)
  }

  await eventBus.emit({
    type: 'arsredovisning.uploaded',
    payload: {
      submissionId,
      fiscalPeriodId: params.fiscalPeriodId,
      idnummer: svar.handlingsinfo.idnummer,
      environment: client.environment,
      userId: params.userId,
      companyId: params.companyId,
    },
  })

  // 9. Subscribe to händelser (idempotent; extends TTL 6 months: GUIDE §4.3).
  try {
    await ensureSubscription(deps, params.companyId, params.userId, orgnr)
  } catch (err) {
    // Non-fatal: polling fallback (hamta-handelser) covers missed webhooks.
    log.warn('handelseprenumeration could not be created/renewed: relying on polling fallback', {
      submissionId,
      companyId: params.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return {
    outcome: 'uploaded',
    submissionId,
    idnummer: svar.handlingsinfo.idnummer,
    sha256: svar.handlingsinfo.sha256checksumma,
    url: svar.url,
    utfall,
  }
}

export async function ensureSubscription(
  deps: ServiceDeps,
  companyId: string,
  userId: string,
  orgnr: string,
): Promise<void> {
  const { supabase, client, appUrl } = deps
  if (!/^https?:\/\//.test(appUrl)) {
    // A relative/empty base URL would register a broken webhook endpoint at
    // Bolagsverket. Fail fast: the caller logs this as a subscription failure.
    throw new Error(
      'NEXT_PUBLIC_APP_URL saknas eller är inte en absolut URL: kan inte registrera webhook hos Bolagsverket.',
    )
  }
  const url = `${appUrl.replace(/\/$/, '')}/api/extensions/ext/bolagsverket/webhook`
  const { data: existing } = await supabase
    .from('bolagsverket_subscriptions')
    .select('id, auth_secret')
    .eq('company_id', companyId)
    .eq('orgnr', orgnr)
    .eq('url', url)
    .eq('environment', client.environment)
    .maybeSingle()
  // Org-number reuse is allowed in this product, and Bolagsverket dedupes
  // subscriptions per (url, orgnr): registering a NEW secret here would
  // overwrite the delivery auth another company sharing this orgnr already
  // depends on, 401-ing their webhooks. Reuse any existing secret for the
  // same (orgnr, url, environment) across ALL companies (service client:
  // RLS would hide other tenants' rows) so everyone sharing the orgnr
  // authenticates the same deliveries.
  let sharedSecret: string | null = null
  if (!existing) {
    const serviceClient = createServiceClientNoCookies()
    const { data: shared } = await serviceClient
      .from('bolagsverket_subscriptions')
      .select('auth_secret')
      .eq('orgnr', orgnr)
      .eq('url', url)
      .eq('environment', client.environment)
      .limit(1)
      .maybeSingle()
    sharedSecret = (shared as { auth_secret?: string } | null)?.auth_secret ?? null
  }
  const secret =
    (existing as { auth_secret?: string } | null)?.auth_secret ??
    sharedSecret ??
    randomBytes(24).toString('base64url')
  await client.createSubscription(url, orgnr, secret)
  const expires = new Date()
  expires.setMonth(expires.getMonth() + 6)
  if (existing) {
    await supabase
      .from('bolagsverket_subscriptions')
      .update({ subscribed_at: new Date().toISOString(), expires_at: expires.toISOString() })
      .eq('id', (existing as { id: string }).id)
  } else {
    await supabase.from('bolagsverket_subscriptions').insert({
      company_id: companyId,
      user_id: userId,
      orgnr,
      url,
      auth_secret: secret,
      environment: client.environment,
      expires_at: expires.toISOString(),
    })
  }
}

/** Bolagsverket ärendestatus → our submission status. */
const STATUS_MAP: Record<string, SubmissionStatus> = {
  arsred_inkommen: 'inkommen',
  arsred_forelaggande_skickat: 'forelagd',
  arsred_komplettering_inkommen: 'komplettering',
  arsred_registrerad: 'registrerad',
  arsred_avslutad_ej_registrerad: 'avslutad',
}

export interface WebhookHandlingResult {
  status: number
  body: { ok: boolean; reason?: string }
}

/**
 * Apply one händelsemeddelande to the submission rows. Used by both the
 * webhook receiver and the polling fallback. `serviceClient` is the
 * cookieless service-role client: all queries still filter by company.
 */
export async function applyHandelse(
  serviceClient: SupabaseClient,
  message: HandelseMeddelande,
  matchedCompanyIds: string[],
  log?: Pick<ExtensionLogger, 'warn' | 'error'>,
): Promise<void> {
  const mapped = STATUS_MAP[message.data.status]
  if (!mapped) return // 'test' or future statuses: nothing to apply

  const idnummerList = (message.data.handlingsinfo ?? [])
    .filter((info) => info.handling === 'arsredovisning')
    .map((info) => info.idnummer)

  for (const companyId of matchedCompanyIds) {
    // Correlate by document idnummer when the message carries one (it does
    // for arsredovisning events); otherwise fall back to the latest active
    // submission for the company.
    const base = serviceClient
      .from('arsredovisning_submissions')
      .select('id, status, fiscal_period_id, user_id, company_id')
      .eq('company_id', companyId)
    const filtered =
      idnummerList.length > 0
        ? base.in('idnummer', idnummerList)
        : base.in('status', ['uploaded', 'inkommen', 'forelagd', 'komplettering'])
    const { data: rows } = await filtered.order('created_at', { ascending: false }).limit(1)
    const submission = (rows as Pick<
      ArsredovisningSubmission,
      'id' | 'status' | 'fiscal_period_id' | 'user_id' | 'company_id'
    >[] | null)?.[0]
    if (!submission) continue
    if (submission.status === mapped) continue

    const update: Record<string, unknown> = { status: mapped }
    if (mapped === 'registrerad') update.registered_at = new Date().toISOString()
    const { error } = await serviceClient
      .from('arsredovisning_submissions')
      .update(update)
      .eq('id', submission.id)
    if (error) {
      // Transition rejected by the DB state machine (or other write failure).
      // Don't apply, but never silently: a divergence between our status and
      // Bolagsverket's must be investigable.
      log?.warn('handelse rejected: submission status not updated', {
        submissionId: submission.id,
        companyId,
        fromStatus: submission.status,
        toStatus: mapped,
        bolagsverketStatus: message.data.status,
        dbError: error.message,
      })
      continue
    }

    await eventBus.emit({
      type: 'arsredovisning.status_changed',
      payload: {
        submissionId: submission.id,
        fiscalPeriodId: submission.fiscal_period_id,
        previousStatus: submission.status,
        status: mapped,
        bolagsverketStatus: message.data.status,
        userId: submission.user_id,
        companyId: submission.company_id,
      },
    })
    if (mapped === 'registrerad') {
      await eventBus.emit({
        type: 'arsredovisning.registered',
        payload: {
          submissionId: submission.id,
          fiscalPeriodId: submission.fiscal_period_id,
          userId: submission.user_id,
          companyId: submission.company_id,
        },
      })
    }
    if (mapped === 'forelagd') {
      await eventBus.emit({
        type: 'arsredovisning.forelagd',
        payload: {
          submissionId: submission.id,
          fiscalPeriodId: submission.fiscal_period_id,
          userId: submission.user_id,
          companyId: submission.company_id,
        },
      })
    }
  }
}

/**
 * Webhook entry: validate the `auth` header against stored subscriptions for
 * the orgnr (GUIDE §5.4.5.2), ack test messages (status "test", nr -1), and
 * apply real events.
 */
/**
 * Constant-time secret comparison: hash both sides to equal-length digests
 * first (timingSafeEqual requires equal lengths and a plain === leaks
 * prefix-match timing).
 */
function secretMatches(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(provided).digest()
  return timingSafeEqual(a, b)
}

export async function handleWebhook(
  serviceClient: SupabaseClient,
  message: HandelseMeddelande,
  authHeader: string | null,
  log?: Pick<ExtensionLogger, 'warn' | 'error'>,
): Promise<WebhookHandlingResult> {
  if (!message || typeof message !== 'object' || !message.data) {
    return { status: 400, body: { ok: false, reason: 'malformed' } }
  }
  // `message.id` is attacker-controllable until the auth check below, so it
  // is used ONLY to look up candidate subscriptions; a delivery is accepted
  // exclusively when its `auth` header matches a secret WE registered with
  // Bolagsverket for exactly this orgnr (the eq below). A valid secret for a
  // different orgnr can never authenticate a spoofed orgnr. Status payloads
  // are still treated as untrusted: STATUS_MAP allowlists transitions and the
  // DB status-machine trigger rejects illegal ones in applyHandelse.
  const orgnr = String(message.id ?? '')
  if (!/^\d{10}$/.test(orgnr)) {
    return { status: 400, body: { ok: false, reason: 'malformed orgnr' } }
  }
  const { data: subs } = await serviceClient
    .from('bolagsverket_subscriptions')
    .select('company_id, auth_secret')
    .eq('orgnr', orgnr)
  const matching = ((subs as Array<{ company_id: string; auth_secret: string }> | null) ?? []).filter(
    (sub) => authHeader !== null && secretMatches(sub.auth_secret, authHeader),
  )
  if (matching.length === 0) {
    return { status: 401, body: { ok: false, reason: 'unknown subscription or bad auth' } }
  }
  if (message.data.status === 'test' || message.nr === -1) {
    return { status: 200, body: { ok: true } }
  }
  await applyHandelse(
    serviceClient,
    message,
    [...new Set(matching.map((sub) => sub.company_id))],
    log,
  )
  return { status: 200, body: { ok: true } }
}
