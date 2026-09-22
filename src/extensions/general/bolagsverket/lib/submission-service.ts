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
 * Personnummer are transient: used for the API calls and never persisted.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { generateK2IxbrlDocument, embedKontrollsumma } from '@/lib/bokslut/ixbrl/document/k2-document'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import { validateIxbrlWithArelle } from '@/lib/bokslut/ixbrl/validate/arelle-client'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
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
  'sending',
  'uploaded',
  'unknown',
  'inkommen',
  'forelagd',
  'komplettering',
] as const

export function hashPnr(companyId: string, pnr: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${companyId}:${pnr.replace(/\D/g, '')}`)
    .digest('hex')
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
 * the params object itself. No personnummer-derived value is needed for the
 * filing audit trail; hashPnr exists only for integrations that need a keyed,
 * non-enumerable correlation reference.
 */
export interface SubmitParams {
  companyId: string
  userId: string
  fiscalPeriodId: string
  annualReportVersionId: string
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
  | {
      outcome: 'state_unknown'
      submissionId: string
      idnummer: string | null
      url: string | null
      message: string
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
  remoteUploadStarted = false,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  const { error } = await supabase
    .from('arsredovisning_submissions')
    .update({
      status: remoteUploadStarted ? 'unknown' : 'error',
      error_message: message.slice(0, 2_000),
    })
    .eq('id', submissionId)
  if (error) {
    log.error('could not mark submission as error', { submissionId, dbError: error.message })
  }
}

async function getOrgnr(supabase: SupabaseClient, companyId: string): Promise<string> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa organisationsnummer: ${error.message}`)
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

  const { data: versionRow, error: versionError } = await supabase
    .from('annual_report_versions')
    .select(
      'id, status, content_hash, ixbrl_data, entry_point, taxonomy_version, validation_summary',
    )
    .eq('id', params.annualReportVersionId)
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .maybeSingle()
  if (versionError || !versionRow) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_VERSION_NOT_FOUND',
      'The annual report version does not exist for this company and period.',
    )
  }
  if (versionRow.status !== 'signed' || !versionRow.ixbrl_data) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_VERSION_NOT_SIGNED',
      'The annual report version must be signed and contain iXBRL before submission.',
      { annual_report_version_id: versionRow.id, status: versionRow.status },
    )
  }
  const validationSnapshot = versionRow.validation_summary as {
    digital_filing_eligible?: boolean
    digital_issues?: unknown[]
  }
  if (validationSnapshot.digital_filing_eligible !== true) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_DIGITAL_INELIGIBLE',
      'The immutable annual report version is not eligible for connected filing.',
      { issues: validationSnapshot.digital_issues ?? [] },
    )
  }

  // 0. Double-submission guard: once an upload reached Bolagsverket, a retry
  //    would file a second handling (and store a second audit document).
  //    Refuse while a submission for this period is still open with the
  //    authority. Rows in draft/kontrollerad/error/registrerad/avslutad do
  //    not block. A pre-upload retry reuses its idempotency row.
  const { data: activeRows, error: activeSubmissionError } = await supabase
    .from('arsredovisning_submissions')
    .select('id, status')
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .in('status', [...ACTIVE_SUBMISSION_STATUSES])
    .limit(1)
  if (activeSubmissionError) {
    throw new Error(`Kunde inte kontrollera tidigare inlämningar: ${activeSubmissionError.message}`)
  }
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
  const { data: acceptance, error: acceptanceError } = await supabase
    .from('bolagsverket_avtal_acceptances')
    .select('id')
    .eq('company_id', params.companyId)
    .eq('user_id', params.userId)
    .eq('avtalstext_andrad', token.avtalstextAndrad)
    .maybeSingle()
  if (acceptanceError) {
    throw new Error(`Kunde inte kontrollera avtalsgodkännandet: ${acceptanceError.message}`)
  }
  const acceptedNow = params.acceptedAvtalstextAndrad === token.avtalstextAndrad
  if (!acceptance && !acceptedNow) {
    return {
      outcome: 'avtal_required',
      avtalstext: token.avtalstext,
      avtalstextAndrad: token.avtalstextAndrad,
    }
  }
  if (!acceptance && acceptedNow) {
    const { error: acceptanceInsertError } = await supabase.from('bolagsverket_avtal_acceptances').insert({
      company_id: params.companyId,
      user_id: params.userId,
      avtalstext_andrad: token.avtalstextAndrad,
    })
    if (acceptanceInsertError) {
      throw new Error(`Kunde inte spara avtalsgodkännandet: ${acceptanceInsertError.message}`)
    }
  }

  // 3. Render from the immutable, signed version. Signature evidence is
  //    stored separately from the content snapshot and overlaid here.
  const input = structuredClone(versionRow.ixbrl_data) as IxbrlArsredovisningInput
  const { data: signatureRows, error: signatureError } = await supabase
    .from('arsredovisning_signature_requests')
    .select('signer_name, role, signed_at, status, signing_method, evidence_reference')
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .eq('annual_report_version_id', params.annualReportVersionId)
  if (signatureError) {
    throw new Error(`Failed to load signature evidence: ${signatureError.message}`)
  }
  const signatures = (signatureRows ?? []) as Array<{
    signer_name: string
    role: string
    signed_at: string | null
    status: string
    signing_method: string | null
    evidence_reference: string | null
  }>
  if (
    signatures.length === 0 ||
    signatures.some(
      (signature) =>
        signature.status !== 'signed' ||
        !signature.signed_at ||
        !signature.signing_method ||
        !signature.evidence_reference,
    )
  ) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_SIGNATURE_EVIDENCE_INCOMPLETE',
      'Every required signer must have version-bound signature evidence.',
      { annual_report_version_id: params.annualReportVersionId },
    )
  }
  input.underskrifter.signers = signatures.map((signature) => {
    const parts = signature.signer_name.trim().split(/\s+/)
    return {
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
      lastName: parts.length > 1 ? parts.at(-1) ?? parts[0] : parts[0],
      role: signature.role,
      signedDate: signature.signed_at?.slice(0, 10) ?? null,
    }
  })
  input.underskrifter.harVd = input.underskrifter.signers.some((signer) =>
    /verkställande direktör|^vd$/i.test(signer.role ?? ''),
  )
  input.underskrifter.dateringsdatum = input.underskrifter.signers
    .map((signer) => signer.signedDate)
    .filter((date): date is string => date !== null)
    .sort()
    .at(-1) ?? null
  const normalizeSignerText = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv')
  if (
    normalizeSignerText(input.faststallelseintyg.signerFirstName) !==
      normalizeSignerText(params.undertecknare.fornamn) ||
    normalizeSignerText(input.faststallelseintyg.signerLastName) !==
      normalizeSignerText(params.undertecknare.efternamn) ||
    normalizeSignerText(input.faststallelseintyg.signerRole) !==
      normalizeSignerText(params.undertecknare.roll)
  ) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_CERTIFICATE_SIGNER_MISMATCH',
      'The certificate signer must match the signer locked into the annual report version.',
      { annual_report_version_id: params.annualReportVersionId },
    )
  }
  input.faststallelseintyg.genereratDatum = new Date().toISOString().slice(0, 10)
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

  // Validate the final bytes after the optional checksum was embedded. The
  // recorded artifact hash must identify the same XHTML that is archived and
  // uploaded, otherwise the validation evidence cannot prove what was filed.
  const artifactHash = createHash('sha256').update(xhtml).digest('hex')
  const { error: localValidationError } = await supabase
    .from('annual_report_validation_runs')
    .insert({
      company_id: params.companyId,
      fiscal_period_id: params.fiscalPeriodId,
      version_id: params.annualReportVersionId,
      user_id: params.userId,
      validation_layer: 'local',
      status: 'passed',
      validator_version: 'accounted-preflight-1',
      artifact_hash: artifactHash,
      issues: preflight.issues,
    })
  if (localValidationError) {
    throw new Error(`Kunde inte spara lokal validering: ${localValidationError.message}`)
  }

  const arelle = await validateIxbrlWithArelle(xhtml)
  const { error: arelleValidationError } = await supabase
    .from('annual_report_validation_runs')
    .insert({
      company_id: params.companyId,
      fiscal_period_id: params.fiscalPeriodId,
      version_id: params.annualReportVersionId,
      user_id: params.userId,
      validation_layer: 'arelle',
      status: arelle.status,
      validator_version: arelle.validator_version,
      artifact_hash: artifactHash,
      issues: arelle.issues,
    })
  if (arelleValidationError) {
    throw new Error(`Kunde inte spara Arelle-validering: ${arelleValidationError.message}`)
  }
  if (arelle.status === 'unavailable') {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_ARELLE_UNAVAILABLE',
      'Arelle validation is unavailable. Connected filing is blocked.',
      { issues: arelle.issues },
    )
  }
  if (arelle.status === 'failed') {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_ARELLE_FAILED',
      'Arelle found blocking taxonomy validation errors.',
      { issues: arelle.issues },
    )
  }

  const fileBase64 = Buffer.from(xhtml, 'utf8').toString('base64')
  const requestKey = createHash('sha256')
    .update(
      `${params.companyId}:${params.annualReportVersionId}:${client.environment}:arsredovisning_komplett`,
    )
    .digest('hex')
  const { data: existingRequest, error: existingRequestError } = await supabase
    .from('arsredovisning_submissions')
    .select('id, status')
    .eq('company_id', params.companyId)
    .eq('environment', client.environment)
    .eq('request_key', requestKey)
    .maybeSingle()
  if (existingRequestError) {
    throw new Error(`Kunde inte kontrollera inlämningens idempotensnyckel: ${existingRequestError.message}`)
  }
  const submissionPayload = {
      company_id: params.companyId,
      user_id: params.userId,
      fiscal_period_id: params.fiscalPeriodId,
      annual_report_version_id: params.annualReportVersionId,
      request_key: requestKey,
      handling_typ: 'arsredovisning_komplett',
      taxonomy_version: versionRow.taxonomy_version,
      entry_point: input.entryPointId,
      environment: client.environment,
      status: 'draft',
      undertecknare_namn: `${params.undertecknare.fornamn} ${params.undertecknare.efternamn}`,
      undertecknare_epost: params.undertecknare.epost,
      undertecknare_pnr_hash: null,
      avsandare_pnr_hash: null,
      kontrollsumma,
      error_message: null,
    }

  // 5. Persist before talking to Bolagsverket. A stopped kontrollera or a
  //    pre-upload error reuses the same idempotency row, which makes the
  //    explicit "continue despite warnings" action work without creating a
  //    second filing attempt for identical content.
  let submissionRow: { id: string } | null = null
  if (existingRequest) {
    if (!['draft', 'kontrollerad', 'error'].includes(existingRequest.status)) {
      throw new BolagsverketSubmissionError(
        'BOLAGSVERKET_SUBMISSION_EXISTS',
        'This exact annual report version already has a submission attempt.',
        { submission_id: existingRequest.id, status: existingRequest.status },
      )
    }
    const { data, error } = await supabase
      .from('arsredovisning_submissions')
      .update({ ...submissionPayload, status: 'draft' })
      .eq('id', existingRequest.id)
      .eq('company_id', params.companyId)
      .select('id')
      .single()
    if (error || !data) {
      throw new Error(`Kunde inte återuppta inlämningsförsöket: ${error?.message ?? 'okänt fel'}`)
    }
    submissionRow = data as { id: string }
  } else {
    const { data, error } = await supabase
      .from('arsredovisning_submissions')
      .insert({ ...submissionPayload, status: 'draft' })
      .select('id')
      .single()
    if (error || !data) {
      throw new Error(`Kunde inte spara inlämningsförsöket: ${error?.message ?? 'okänt fel'}`)
    }
    submissionRow = data as { id: string }
  }
  const submissionId = submissionRow.id

  // Steps 6-8 talk to Bolagsverket with a persisted row in play. Failures
  // before the external upload become error. Once upload starts, uncertain
  // outcomes become unknown and retries are blocked until reconciled.
  let svar: Awaited<ReturnType<BolagsverketClient['lamnaIn']>>
  let utfall: KontrolleraUtfall[]
  let remoteUploadStarted = false
  try {
    // 6. Kontrollera (layer 3): always run; surface utfall to the user.
    const kontrollSvar = await client.kontrollera(token.token, fileBase64, 'arsredovisning_komplett')
    utfall = kontrollSvar.utfall ?? []
    const { error: kontrollUpdateError } = await supabase
      .from('arsredovisning_submissions')
      .update({ status: 'kontrollerad', kontrollera_utfall: utfall })
      .eq('id', submissionId)
    if (kontrollUpdateError) {
      throw new Error(`Kunde inte spara Bolagsverkets kontrollresultat: ${kontrollUpdateError.message}`)
    }
    const hasBlocking = utfall.some((item) => item.typ?.toLowerCase() === 'error')
    if (utfall.length > 0 && (hasBlocking || !params.ignoreWarnings)) {
      return { outcome: 'kontrollera_stopped', submissionId, utfall }
    }

    // 7. Store the exact uploaded bytes as räkenskapsinformation (7-year
    //    retention, Accounting Guard Rail #7) BEFORE upload.
    const buffer = Buffer.from(xhtml, 'utf8')
    let doc: Awaited<ReturnType<typeof uploadDocument>>
    try {
      doc = await uploadDocument(
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase
        .from('arsredovisning_submissions')
        .update({ archive_status: 'failed', error_message: message.slice(0, 2_000) })
        .eq('id', submissionId)
      throw new Error(`Dokumentarkivering misslyckades: ${message}`)
    }
    const dokumentId = doc.id
    const { error: archiveUpdateError } = await supabase
      .from('arsredovisning_submissions')
      .update({ dokument_id: dokumentId, archive_status: 'stored' })
      .eq('id', submissionId)
    if (archiveUpdateError) {
      throw new Error(`Kunde inte koppla det arkiverade dokumentet: ${archiveUpdateError.message}`)
    }

    // 8. Lämna in till eget utrymme.
    const uploadStartedAt = new Date().toISOString()
    const { error: sendingUpdateError } = await supabase
      .from('arsredovisning_submissions')
      .update({ status: 'sending', upload_started_at: uploadStartedAt })
      .eq('id', submissionId)
    if (sendingUpdateError) {
      throw new Error(`Kunde inte låsa inlämningsförsöket före uppladdning: ${sendingUpdateError.message}`)
    }
    remoteUploadStarted = true
    try {
      svar = await client.lamnaIn(token.token, {
        undertecknare: params.undertecknare.pnr,
        epostadresser: [params.undertecknare.epost],
        kvittensepostadresser: params.kvittensEpost,
        fileBase64,
        typ: 'arsredovisning_komplett',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase
        .from('arsredovisning_submissions')
        .update({ status: 'unknown', error_message: message.slice(0, 2_000) })
        .eq('id', submissionId)
      log.error('Bolagsverket upload outcome is unknown: retry blocked', {
        submissionId,
        companyId: params.companyId,
        error: message,
      })
      return {
        outcome: 'state_unknown',
        submissionId,
        idnummer: null,
        url: null,
        message:
          'Bolagsverkets mottagande kunde inte bekräftas. Försök inte igen innan status har stämts av.',
      }
    }

    const uploadedAt = new Date().toISOString()
    const externalReceipt = {
      idnummer: svar.handlingsinfo.idnummer,
      sha256_checksumma: svar.handlingsinfo.sha256checksumma,
      url: svar.url,
      received_at: uploadedAt,
    }
    const { error: uploadUpdateError } = await supabase
      .from('arsredovisning_submissions')
      .update({
        status: 'uploaded',
        idnummer: svar.handlingsinfo.idnummer,
        sha256_checksumma: svar.handlingsinfo.sha256checksumma,
        bolagsverket_url: svar.url,
        dokument_id: dokumentId,
        external_receipt: externalReceipt,
        uploaded_at: uploadedAt,
      })
      .eq('id', submissionId)
    if (uploadUpdateError) {
      log.error('failed to persist uploaded state after successful inlämning: marking unknown', {
        submissionId,
        idnummer: svar.handlingsinfo.idnummer,
        dbError: uploadUpdateError.message,
      })
      const serviceClient = createServiceClientNoCookies()
      const { error: recoveryError } = await serviceClient
        .from('arsredovisning_submissions')
        .update({
          status: 'unknown',
          idnummer: svar.handlingsinfo.idnummer,
          sha256_checksumma: svar.handlingsinfo.sha256checksumma,
          bolagsverket_url: svar.url,
          dokument_id: dokumentId,
          external_receipt: externalReceipt,
          uploaded_at: uploadedAt,
          error_message: `Uppladdningen lyckades men lokal status kunde inte bekräftas: ${uploadUpdateError.message}`.slice(0, 2_000),
        })
        .eq('id', submissionId)
      if (recoveryError) {
        log.error('could not persist unknown state after successful remote upload', {
          submissionId,
          dbError: recoveryError.message,
        })
      }
      return {
        outcome: 'state_unknown',
        submissionId,
        idnummer: svar.handlingsinfo.idnummer,
        url: svar.url,
        message:
          'Bolagsverket tog emot dokumentet men Accounted kunde inte bekräfta lokal status. Skicka inte igen.',
      }
    }
    const { error: versionStatusError } = await supabase
      .from('annual_report_versions')
      .update({ status: 'filed' })
      .eq('id', params.annualReportVersionId)
      .eq('company_id', params.companyId)
      .eq('status', 'signed')
    if (versionStatusError) {
      log.error('failed to mark annual report version as filed', {
        submissionId,
        annualReportVersionId: params.annualReportVersionId,
        dbError: versionStatusError.message,
      })
    }
  } catch (err) {
    await markSubmissionError(supabase, log, submissionId, err, remoteUploadStarted)
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
      .select('id, status, fiscal_period_id, user_id, company_id, annual_report_version_id')
      .eq('company_id', companyId)
    const filtered =
      idnummerList.length > 0
        ? base.in('idnummer', idnummerList)
        : base.in('status', ['unknown', 'uploaded', 'inkommen', 'forelagd', 'komplettering'])
    const { data: rows } = await filtered.order('created_at', { ascending: false }).limit(1)
    const submission = (rows as Pick<
      ArsredovisningSubmission,
      | 'id'
      | 'status'
      | 'fiscal_period_id'
      | 'user_id'
      | 'company_id'
      | 'annual_report_version_id'
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
      if (submission.annual_report_version_id) {
        const { error: versionError } = await serviceClient
          .from('annual_report_versions')
          .update({ status: 'registered' })
          .eq('id', submission.annual_report_version_id)
          .eq('company_id', companyId)
          .eq('status', 'filed')
        if (versionError) {
          log?.warn('registered submission did not update annual report version', {
            submissionId: submission.id,
            versionId: submission.annual_report_version_id,
            dbError: versionError.message,
          })
        }
      }
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
