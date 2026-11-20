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
import { companyOrgNumber } from '@/lib/company/org-number'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { generateIxbrlDocument, embedKontrollsumma } from '@/lib/bokslut/ixbrl/document/generate'
import { k3IxbrlEnabled } from '@/lib/bokslut/ixbrl/k3-release'
import { K3_AB_RISBS_2021_10_31 } from '@/lib/bokslut/ixbrl/taxonomy/entry-points'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import { validateIxbrlWithArelle } from '@/lib/bokslut/ixbrl/validate/arelle-client'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
import { certificateRole } from '@/lib/bokslut/ixbrl/certificate-role'
import {
  overlayFaststallelseintyg,
  overlayRevisorspateckning,
  overlayVersionSignatures,
} from '@/lib/bokslut/arsredovisning/version-ixbrl'
import { BolagsverketClient } from './client'
import type { ExtensionLogger } from '@/lib/extensions/types'
import type {
  ArsredovisningSubmission,
  HandelseMeddelande,
  HandlingTyp,
  KontrolleraUtfall,
  SubmissionStatus,
} from '../types'
import { todayIsoStockholm } from '@/lib/dates/iso'

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
  /**
   * notifieringEpostadresser (API 2.1): told that a handling was uploaded.
   * For an årsredovisning whose revisionsberättelse is kompletteras, the
   * revisor's address, so the revisor knows a revisionsberättelse is expected.
   */
  notifieringEpost?: string[]
  /** User accepted the current avtalstext (avtalstextAndrad value). */
  acceptedAvtalstextAndrad?: string
  /** Upload even when kontrollera returns warn-level utfall (GUIDE §4.2.2). */
  ignoreWarnings?: boolean
}

type UploadOutcome =
  | {
      outcome: 'kontrollera_stopped'
      submissionId: string
      utfall: KontrolleraUtfall[]
    }
  | {
      outcome: 'uploaded'
      submissionId: string
      handlingTyp: HandlingTyp
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

type AvtalRequired = { outcome: 'avtal_required'; avtalstext: string; avtalstextAndrad: string }

export type SubmitResult =
  | AvtalRequired
  | { outcome: 'preflight_failed'; issues: ReturnType<typeof runPreflightChecks>['issues'] }
  | UploadOutcome

export type SubmitRevisionsberattelseResult = AvtalRequired | UploadOutcome

/** The two handling types an årsredovisning goes up as (API 2.1 Handling.typ). */
export const ARSREDOVISNING_HANDLING_TYPES = ['arsredovisning_komplett', 'arsredovisning_kompletteras'] as const

/**
 * Which handling the årsredovisning is uploaded as (Bolagsverket API 2.1,
 * Handling.typ): `arsredovisning_komplett` when the revisionsberättelse is in
 * the same file or none is required, `arsredovisning_kompletteras` when a
 * revisionsberättelse follows as its own file. Accounted never puts the
 * revisionsberättelse in the årsredovisning's file (the revisor writes it), so
 * a company with a revisionsberättelse (required, or a revisor in the roster)
 * always files kompletteras.
 */
export function arsredovisningHandlingTyp(
  input: Pick<IxbrlArsredovisningInput, 'revisorspateckning'>,
): (typeof ARSREDOVISNING_HANDLING_TYPES)[number] {
  const pateckning = input.revisorspateckning
  return pateckning && (pateckning.required || pateckning.revisorer.length > 0)
    ? 'arsredovisning_kompletteras'
    : 'arsredovisning_komplett'
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

/** The 10-digit orgnr the API expects (no dash, no century). */
export async function getOrgnr(supabase: SupabaseClient, companyId: string): Promise<string> {
  const orgNumber = await companyOrgNumber(supabase, companyId)
  if (!orgNumber) throw new Error('Organisationsnummer saknas i företagsinställningarna.')
  return orgNumber
}

/**
 * Avtalstext gate (GUIDE §4.2): the user must have accepted THIS version of
 * the text for THIS company before kontrollera/inlämning may run. Returns
 * the text to show when it is not accepted yet, null when the call may go on.
 */
async function avtalGate(
  supabase: SupabaseClient,
  params: { companyId: string; userId: string; acceptedAvtalstextAndrad?: string },
  token: { avtalstext: string; avtalstextAndrad: string },
): Promise<AvtalRequired | null> {
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
  return null
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
  // The K3 flag is a kill switch: a K3 version locked while it was on is
  // not filed once it is off.
  if (versionRow.entry_point === K3_AB_RISBS_2021_10_31.id && !k3IxbrlEnabled()) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_K3_FILING_CLOSED',
      'Connected filing of K3 annual reports is switched off (NEXT_PUBLIC_K3_IXBRL_ENABLED).',
      { annual_report_version_id: versionRow.id },
    )
  }

  // 0. Double-submission guard: once an upload reached Bolagsverket, a retry
  //    would file a second handling (and store a second audit document).
  //    Refuse while an årsredovisning for this period is still open with the
  //    authority. Rows in draft/kontrollerad/error/registrerad/avslutad do
  //    not block, nor does the separate revisionsberättelse. A pre-upload
  //    retry reuses its idempotency row.
  const { data: activeRows, error: activeSubmissionError } = await supabase
    .from('arsredovisning_submissions')
    .select('id, status')
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .in('handling_typ', [...ARSREDOVISNING_HANDLING_TYPES])
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

  // 2. Avtalstext gate.
  const avtal = await avtalGate(supabase, params, token)
  if (avtal) return avtal

  // 3. Render from the immutable, signed version. Signature evidence is
  //    stored separately from the content snapshot and overlaid here.
  const input = structuredClone(versionRow.ixbrl_data) as IxbrlArsredovisningInput
  const { data: signatureRows, error: signatureError } = await supabase
    .from('arsredovisning_signature_requests')
    .select('signer_name, role, signed_at, status, signing_method, evidence_reference, pateckning_opinion, pateckning_firm_name')
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
  // Every slot, the revisor's påteckning included, must carry evidence: the
  // version is signed only when all of them are (trigger
  // complete_annual_report_version_signing).
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
  // Every signature was checked above: the version is fully signed.
  overlayVersionSignatures(input, signatures, { complete: true })
  const normalizeSignerText = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv')
  // Roles compare in the taxonomy's vocabulary: the filing form offers the
  // roles Bolagsverket accepts, while the locked roster may say
  // "Styrelseordförande" or "VD" for the same capacity.
  if (
    normalizeSignerText(input.faststallelseintyg.signerFirstName) !==
      normalizeSignerText(params.undertecknare.fornamn) ||
    normalizeSignerText(input.faststallelseintyg.signerLastName) !==
      normalizeSignerText(params.undertecknare.efternamn) ||
    normalizeSignerText(certificateRole(input.faststallelseintyg.signerRole)) !==
      normalizeSignerText(certificateRole(params.undertecknare.roll))
  ) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_CERTIFICATE_SIGNER_MISMATCH',
      'The certificate signer must match the signer locked into the annual report version.',
      { annual_report_version_id: params.annualReportVersionId },
    )
  }
  await overlayFaststallelseintyg(
    supabase,
    params.companyId,
    params.fiscalPeriodId,
    input,
    todayIsoStockholm(),
  )
  // The revisorspåteckning (ABL 9 kap. 28 §) is given after the board
  // signed: put the revisor slots and the profile's opinion on top.
  await overlayRevisorspateckning(supabase, params.companyId, params.fiscalPeriodId, input, signatures)
  const preflight = runPreflightChecks(input)
  if (!preflight.ok) {
    return { outcome: 'preflight_failed', issues: preflight.issues }
  }
  let { xhtml } = generateIxbrlDocument(input)

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

  const handlingTyp = arsredovisningHandlingTyp(input)
  const result = await uploadHandling(deps, {
    companyId: params.companyId,
    userId: params.userId,
    fiscalPeriodId: params.fiscalPeriodId,
    annualReportVersionId: params.annualReportVersionId,
    // The komplett key is unchanged from before kompletteras existed, so a
    // pre-upload retry of an older attempt still finds its row.
    requestKeySeed: `${params.companyId}:${params.annualReportVersionId}:${client.environment}:${handlingTyp}`,
    handlingTyp,
    taxonomyVersion: versionRow.taxonomy_version,
    entryPoint: input.entryPointId,
    xhtml,
    documentName: `arsredovisning-${input.period.end}-inlamnad.xhtml`,
    token: token.token,
    undertecknare: {
      pnr: params.undertecknare.pnr,
      namn: `${params.undertecknare.fornamn} ${params.undertecknare.efternamn}`,
      epost: params.undertecknare.epost,
    },
    kvittensEpost: params.kvittensEpost,
    notifieringEpost: params.notifieringEpost,
    kontrollsumma,
    ignoreWarnings: params.ignoreWarnings,
  })
  if (result.outcome === 'uploaded') {
    await afterUpload(deps, params, orgnr, result)
  }
  return result
}

/**
 * The revisionsberättelse as its own handling (API 2.1 Handling.typ
 * `revisionsberattelse`), after the årsredovisning went up as
 * `arsredovisning_kompletteras`. The file is the revisor's: their software
 * produces the revisionsberättelse in iXBRL against Bolagsverket's
 * revisionsberättelse taxonomy, and the revisor signs it at Bolagsverket
 * (`undertecknare` is the revisor). Accounted checks that it is such a file,
 * validates the exact bytes against the taxonomy with Arelle (the same path
 * as the årsredovisning, failing closed), archives them, runs kontrollera and
 * uploads it. The content is the revisor's responsibility, so Accounted's own
 * preflight rules do not apply to it.
 */
export interface SubmitRevisionsberattelseParams {
  companyId: string
  userId: string
  fiscalPeriodId: string
  /** Avsändarens personnummer (12 siffror): whose eget utrymme the file lands in. */
  avsandarePnr: string
  /** The revisor, who signs the revisionsberättelse at Bolagsverket. */
  undertecknare: {
    pnr: string
    fornamn: string
    efternamn: string
    epost: string
  }
  /** The revisionsberättelse, iXBRL XHTML in UTF-8, as the revisor delivered it. */
  xhtml: string
  kvittensEpost?: string[]
  /** Told that the revisionsberättelse was uploaded (e.g. the company's contact). */
  notifieringEpost?: string[]
  acceptedAvtalstextAndrad?: string
  ignoreWarnings?: boolean
}

/** Bolagsverket's maximum document size (felkod 5006). */
export const MAX_HANDLING_BYTES = 5 * 1024 * 1024

/**
 * What a revisionsberättelse file must look like before it is sent: XHTML
 * with an ix:header that references a revisionsberättelse taxonomy
 * (xbrl.taxonomier.se/se/fr/ar/<rapport>/<version>/<entry>.xsd, e.g. rar or
 * rarc), within the size limit. Returns the entry point and version for the
 * submission row.
 */
export function inspectRevisionsberattelse(xhtml: string): { entryPoint: string; taxonomyVersion: string } {
  const bytes = Buffer.byteLength(xhtml, 'utf8')
  const ref = xhtml.match(
    /<link:schemaRef[^>]*xlink:href="https?:\/\/xbrl\.taxonomier\.se\/se\/fr\/ar\/[a-z]+\/(\d{4}-\d{2}-\d{2})\/([a-z0-9-]+)\.xsd"/i,
  )
  if (
    bytes === 0 ||
    bytes >= MAX_HANDLING_BYTES ||
    !/<html[\s>]/i.test(xhtml) ||
    !/<ix:header[\s>]/i.test(xhtml) ||
    !ref
  ) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_RB_INVALID_FILE',
      'The file is not an iXBRL audit report referencing the Bolagsverket audit report taxonomy.',
      { bytes },
    )
  }
  return { entryPoint: ref[2], taxonomyVersion: ref[1] }
}

export async function submitRevisionsberattelse(
  deps: ServiceDeps,
  params: SubmitRevisionsberattelseParams,
): Promise<SubmitRevisionsberattelseResult> {
  const { supabase, client } = deps
  const { entryPoint, taxonomyVersion } = inspectRevisionsberattelse(params.xhtml)
  const orgnr = await getOrgnr(supabase, params.companyId)

  // The årsredovisning it completes: uploaded as kompletteras and still open
  // with Bolagsverket (an uncertain upload is reconciled first).
  const { data: arRows, error: arError } = await supabase
    .from('arsredovisning_submissions')
    .select('id, annual_report_version_id, status')
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .eq('environment', client.environment)
    .eq('handling_typ', 'arsredovisning_kompletteras')
    .in('status', ['uploaded', 'inkommen', 'forelagd', 'komplettering'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (arError) throw new Error(`Kunde inte läsa årsredovisningens inlämning: ${arError.message}`)
  const arsredovisning = (
    arRows as Array<{ id: string; annual_report_version_id: string | null; status: string }> | null
  )?.[0]
  if (!arsredovisning) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_RB_NO_ARSREDOVISNING',
      'No annual report uploaded as arsredovisning_kompletteras is open for this fiscal period.',
    )
  }

  const { data: activeRows, error: activeError } = await supabase
    .from('arsredovisning_submissions')
    .select('id, status')
    .eq('company_id', params.companyId)
    .eq('fiscal_period_id', params.fiscalPeriodId)
    .eq('handling_typ', 'revisionsberattelse')
    .in('status', [...ACTIVE_SUBMISSION_STATUSES])
    .limit(1)
  if (activeError) throw new Error(`Kunde inte kontrollera tidigare inlämningar: ${activeError.message}`)
  const active = (activeRows as Array<{ id: string; status: string }> | null)?.[0]
  if (active) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_SUBMISSION_EXISTS',
      `An active audit report submission (${active.status}) already exists for this fiscal period.`,
      { submission_id: active.id, status: active.status },
    )
  }

  // Taxonomy validation before anything reaches Bolagsverket, as for the
  // årsredovisning: an error or an unavailable validator stops the upload.
  // The run is kept with the årsredovisning version it completes; its
  // artifact_hash is the revisionsberättelse's own.
  const fileHash = createHash('sha256').update(params.xhtml).digest('hex')
  const arelle = await validateIxbrlWithArelle(params.xhtml, { filename: 'revisionsberattelse.xhtml' })
  if (arsredovisning.annual_report_version_id) {
    const { error: runError } = await supabase.from('annual_report_validation_runs').insert({
      company_id: params.companyId,
      fiscal_period_id: params.fiscalPeriodId,
      version_id: arsredovisning.annual_report_version_id,
      user_id: params.userId,
      validation_layer: 'arelle',
      status: arelle.status,
      validator_version: arelle.validator_version,
      artifact_hash: fileHash,
      issues: arelle.issues,
    })
    if (runError) throw new Error(`Kunde inte spara Arelle-validering: ${runError.message}`)
  }
  if (arelle.status === 'unavailable') {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_ARELLE_UNAVAILABLE',
      'Arelle validation is unavailable. Filing the audit report is blocked.',
      { issues: arelle.issues },
    )
  }
  if (arelle.status === 'failed') {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_RB_ARELLE_FAILED',
      'Arelle found blocking taxonomy validation errors in the audit report.',
      { issues: arelle.issues },
    )
  }

  const token = await client.createInlamningToken(params.avsandarePnr, orgnr)
  const avtal = await avtalGate(supabase, params, token)
  if (avtal) return avtal

  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_end')
    .eq('id', params.fiscalPeriodId)
    .eq('company_id', params.companyId)
    .maybeSingle()
  if (periodError || !period) throw new Error('Räkenskapsåret hittades inte.')

  const result = await uploadHandling(deps, {
    companyId: params.companyId,
    userId: params.userId,
    fiscalPeriodId: params.fiscalPeriodId,
    annualReportVersionId: arsredovisning.annual_report_version_id,
    requestKeySeed: `${params.companyId}:${params.fiscalPeriodId}:${client.environment}:revisionsberattelse:${fileHash}`,
    handlingTyp: 'revisionsberattelse',
    taxonomyVersion,
    entryPoint,
    xhtml: params.xhtml,
    documentName: `revisionsberattelse-${(period as { period_end: string }).period_end}-inlamnad.xhtml`,
    token: token.token,
    undertecknare: {
      pnr: params.undertecknare.pnr,
      namn: `${params.undertecknare.fornamn} ${params.undertecknare.efternamn}`,
      epost: params.undertecknare.epost,
    },
    kvittensEpost: params.kvittensEpost,
    notifieringEpost: params.notifieringEpost,
    kontrollsumma: null,
    ignoreWarnings: params.ignoreWarnings,
  })
  if (result.outcome === 'uploaded') {
    await afterUpload(deps, params, orgnr, result)
  }
  return result
}

interface UploadHandlingArgs {
  companyId: string
  userId: string
  fiscalPeriodId: string
  annualReportVersionId: string | null
  /** Hashed into request_key: one idempotency row per identical attempt. */
  requestKeySeed: string
  handlingTyp: HandlingTyp
  taxonomyVersion: string
  entryPoint: string
  xhtml: string
  documentName: string
  token: string
  undertecknare: { pnr: string; namn: string; epost: string }
  kvittensEpost?: string[]
  notifieringEpost?: string[]
  kontrollsumma: string | null
  ignoreWarnings?: boolean
}

/**
 * Steps 5-8, shared by the årsredovisning and the revisionsberättelse:
 * persist the attempt, kontrollera, archive the exact bytes, upload to eget
 * utrymme, record the receipt. Failures before the upload become error; once
 * the upload started, an uncertain outcome becomes unknown and a retry is
 * blocked until it is reconciled.
 */
async function uploadHandling(deps: ServiceDeps, args: UploadHandlingArgs): Promise<UploadOutcome> {
  const { supabase, client, log } = deps
  const fileBase64 = Buffer.from(args.xhtml, 'utf8').toString('base64')
  const requestKey = createHash('sha256').update(args.requestKeySeed).digest('hex')
  const { data: existingRequest, error: existingRequestError } = await supabase
    .from('arsredovisning_submissions')
    .select('id, status')
    .eq('company_id', args.companyId)
    .eq('environment', client.environment)
    .eq('request_key', requestKey)
    .maybeSingle()
  if (existingRequestError) {
    throw new Error(`Kunde inte kontrollera inlämningens idempotensnyckel: ${existingRequestError.message}`)
  }
  const submissionPayload = {
    company_id: args.companyId,
    user_id: args.userId,
    fiscal_period_id: args.fiscalPeriodId,
    annual_report_version_id: args.annualReportVersionId,
    request_key: requestKey,
    handling_typ: args.handlingTyp,
    taxonomy_version: args.taxonomyVersion,
    entry_point: args.entryPoint,
    environment: client.environment,
    status: 'draft',
    undertecknare_namn: args.undertecknare.namn,
    undertecknare_epost: args.undertecknare.epost,
    undertecknare_pnr_hash: null,
    avsandare_pnr_hash: null,
    kontrollsumma: args.kontrollsumma,
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
        'This exact document already has a submission attempt.',
        { submission_id: existingRequest.id, status: existingRequest.status },
      )
    }
    const { data, error } = await supabase
      .from('arsredovisning_submissions')
      .update({ ...submissionPayload, status: 'draft' })
      .eq('id', existingRequest.id)
      .eq('company_id', args.companyId)
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

  let svar: Awaited<ReturnType<BolagsverketClient['lamnaIn']>>
  let utfall: KontrolleraUtfall[]
  let remoteUploadStarted = false
  try {
    // 6. Kontrollera (layer 3): always run; surface utfall to the user.
    const kontrollSvar = await client.kontrollera(args.token, fileBase64, args.handlingTyp)
    utfall = kontrollSvar.utfall ?? []
    const { error: kontrollUpdateError } = await supabase
      .from('arsredovisning_submissions')
      .update({ status: 'kontrollerad', kontrollera_utfall: utfall })
      .eq('id', submissionId)
    if (kontrollUpdateError) {
      throw new Error(`Kunde inte spara Bolagsverkets kontrollresultat: ${kontrollUpdateError.message}`)
    }
    const hasBlocking = utfall.some((item) => item.typ?.toLowerCase() === 'error')
    if (utfall.length > 0 && (hasBlocking || !args.ignoreWarnings)) {
      return { outcome: 'kontrollera_stopped', submissionId, utfall }
    }

    // 7. Store the exact uploaded bytes as räkenskapsinformation (7-year
    //    retention, Accounting Guard Rail #7) BEFORE upload.
    const buffer = Buffer.from(args.xhtml, 'utf8')
    let doc: Awaited<ReturnType<typeof uploadDocument>>
    try {
      doc = await uploadDocument(
        supabase,
        args.userId,
        args.companyId,
        {
          name: args.documentName,
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
      svar = await client.lamnaIn(args.token, {
        undertecknare: args.undertecknare.pnr,
        epostadresser: [args.undertecknare.epost],
        kvittensepostadresser: args.kvittensEpost,
        notifieringEpostadresser: args.notifieringEpost,
        fileBase64,
        typ: args.handlingTyp,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await supabase
        .from('arsredovisning_submissions')
        .update({ status: 'unknown', error_message: message.slice(0, 2_000) })
        .eq('id', submissionId)
      log.error('Bolagsverket upload outcome is unknown: retry blocked', {
        submissionId,
        companyId: args.companyId,
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
    // The årsredovisning's version is filed; the revisionsberättelse only
    // completes it.
    if (args.handlingTyp !== 'revisionsberattelse' && args.annualReportVersionId) {
      const { error: versionStatusError } = await supabase
        .from('annual_report_versions')
        .update({ status: 'filed' })
        .eq('id', args.annualReportVersionId)
        .eq('company_id', args.companyId)
        .eq('status', 'signed')
      if (versionStatusError) {
        log.error('failed to mark annual report version as filed', {
          submissionId,
          annualReportVersionId: args.annualReportVersionId,
          dbError: versionStatusError.message,
        })
      }
    }
  } catch (err) {
    await markSubmissionError(supabase, log, submissionId, err, remoteUploadStarted)
    throw err // preserved for the route's error mapping (5xx / upstream status)
  }

  return {
    outcome: 'uploaded',
    submissionId,
    handlingTyp: args.handlingTyp,
    idnummer: svar.handlingsinfo.idnummer,
    sha256: svar.handlingsinfo.sha256checksumma,
    url: svar.url,
    utfall,
  }
}

/** Event + händelseprenumeration after a confirmed upload. */
async function afterUpload(
  deps: ServiceDeps,
  params: { companyId: string; userId: string; fiscalPeriodId: string },
  orgnr: string,
  result: Extract<UploadOutcome, { outcome: 'uploaded' }>,
): Promise<void> {
  await eventBus.emit({
    type: 'arsredovisning.uploaded',
    payload: {
      submissionId: result.submissionId,
      fiscalPeriodId: params.fiscalPeriodId,
      idnummer: result.idnummer,
      environment: deps.client.environment,
      userId: params.userId,
      companyId: params.companyId,
    },
  })

  // 9. Subscribe to händelser (idempotent; extends TTL 6 months: GUIDE §4.3).
  try {
    await ensureSubscription(deps, params.companyId, params.userId, orgnr)
  } catch (err) {
    // Non-fatal: polling fallback (hamta-handelser) covers missed webhooks.
    deps.log.warn('handelseprenumeration could not be created/renewed: relying on polling fallback', {
      submissionId: result.submissionId,
      companyId: params.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function ensureSubscription(
  deps: ServiceDeps,
  companyId: string,
  userId: string,
  orgnr: string,
): Promise<void> {
  const { client, appUrl } = deps
  if (!/^https?:\/\//.test(appUrl)) {
    // A relative/empty base URL would register a broken webhook endpoint at
    // Bolagsverket. Fail fast: the caller logs this as a subscription failure.
    throw new Error(
      'NEXT_PUBLIC_APP_URL saknas eller är inte en absolut URL: kan inte registrera webhook hos Bolagsverket.',
    )
  }
  const url = `${appUrl.replace(/\/$/, '')}/api/extensions/ext/bolagsverket/webhook`
  // auth_secret authenticates Bolagsverket's deliveries to our webhook, so it
  // is withheld from end-user roles and the row is written by the server
  // only: every read and write of a subscription runs on the service role,
  // scoped to the company the caller's submission already resolved.
  const serviceClient = createServiceClientNoCookies()
  const { data: existing } = await serviceClient
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
    await serviceClient
      .from('bolagsverket_subscriptions')
      .update({ subscribed_at: new Date().toISOString(), expires_at: expires.toISOString() })
      .eq('id', (existing as { id: string }).id)
      .eq('company_id', companyId)
  } else {
    await serviceClient.from('bolagsverket_subscriptions').insert({
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
 *
 * The ärende status covers the årsredovisning and, when it was filed
 * kompletteras, its separate revisionsberättelse: a message names the
 * handlings it concerns by idnummer, and every matching row moves. The
 * version and the registered/förelagd events follow the årsredovisning only,
 * so a case with two handlings notifies once.
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
    .filter((info) => info.handling === 'arsredovisning' || info.handling === 'revisionsberattelse')
    .map((info) => info.idnummer)

  for (const companyId of matchedCompanyIds) {
    // Correlate by document idnummer when the message carries one (it does
    // for arsredovisning events); otherwise fall back to the latest active
    // årsredovisning for the company.
    const base = serviceClient
      .from('arsredovisning_submissions')
      .select('id, status, fiscal_period_id, user_id, company_id, annual_report_version_id, handling_typ')
      .eq('company_id', companyId)
    const filtered =
      idnummerList.length > 0
        ? base.in('idnummer', idnummerList)
        : base
            .in('handling_typ', [...ARSREDOVISNING_HANDLING_TYPES])
            .in('status', ['unknown', 'uploaded', 'inkommen', 'forelagd', 'komplettering'])
    const { data: rows } = await filtered
      .order('created_at', { ascending: false })
      .limit(idnummerList.length > 0 ? idnummerList.length : 1)
    const submissions = (rows as Array<
      Pick<
        ArsredovisningSubmission,
        'id' | 'status' | 'fiscal_period_id' | 'user_id' | 'company_id' | 'annual_report_version_id'
      > & { handling_typ?: HandlingTyp }
    > | null) ?? []

    for (const submission of submissions) {
      if (submission.status === mapped) continue
      const isArsredovisning = submission.handling_typ !== 'revisionsberattelse'

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
      if (!isArsredovisning) continue
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
