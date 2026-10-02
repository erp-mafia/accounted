/**
 * What a user can do to a räkenskapsår's årsredovisning before it is filed:
 * edit the narrative texts, answer the compliance profile, freeze a version
 * (a draft snapshot or the version that gets signed), and keep the signer
 * roster (add, record a signature or a decline, remove an unbound slot).
 * One implementation behind the dashboard routes under
 * /api/bookkeeping/fiscal-periods/[id]/arsredovisning/** and the operations
 * in lib/operations/arsredovisning.ts, so every door applies the same rules:
 *
 *   - the period must belong to the company (service-role doors skip RLS);
 *   - the narrative is document text (ÅRL 6 kap.), not räkenskapsinformation,
 *     so it stays editable after the period is closed, and freezes only once
 *     a Bolagsverket submission for the period is registrerad; a save clears
 *     the narrative confirmation;
 *   - a version is only created from a complete, import-free read of the
 *     books (withSIEPeriodRead) whose statements tie; finalize also needs
 *     every signing-stage check green, and runs through the service-role RPC
 *     that binds the signer roster to the version. A caller may pin the
 *     content hash it reviewed (expected_content_hash): the MCP stage pins
 *     the hash its preview showed, so an approval never freezes content the
 *     approver did not see;
 *   - signatures are data records (who signed the paper original or the
 *     e-signature, where the evidence is kept), never BankID: one pending
 *     unbound slot per role and name, a signature only on a
 *     ready_for_signature version and dated between its finalization and
 *     today, transitions only from pending, and only unbound slots are
 *     removable.
 *
 * Filing with Bolagsverket (BankID-signed fastställelseintyg) is not here.
 *
 * A dry run reads, checks and answers a preview; it writes nothing (no
 * upsert, no RPC, no SIE read lease). It is also the MCP staging preview.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { createServiceClient } from '@/lib/supabase/server'
import { withSIEPeriodRead } from '@/lib/import/sie-period-read'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import { buildCanonicalAnnualReport } from './model'
import { getAnnualReportCapabilities } from './capabilities'
import { upsertAnnualReportProfile } from './profile-service'
import { upsertNarrative, type NarrativeRow } from './narrative-service'
import {
  annualReportContentHash,
  createAnnualReportVersion,
  hasStatementIntegrityErrors,
} from './version-service'
import {
  createSignatureRequest,
  listSignatureRequests,
  markSignatureSigned,
  type SignatureRequest,
} from './signature-service'
import type { AnnualReportVersionSummary, CanonicalAnnualReport } from './compliance-types'
import type {
  ComplianceUpdateInput,
  NarrativeUpdateInput,
  SignatoryCreateInput,
  SignatureTransitionInput,
  VersionCreateInput,
} from './workflow-schemas'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const PERIOD_NOT_FOUND: Failure = { ok: false, code: 'PERIOD_NOT_FOUND' }

function failed(error: unknown): Failure {
  // The report builder throws 'Fiscal period not found' for a missing or
  // foreign period (it applies the same company_id filter).
  const message = error instanceof Error ? error.message : ''
  if (/fiscal period not found/i.test(message)) return PERIOD_NOT_FOUND
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

async function periodBelongsToCompany(ctx: OperationContext, fiscalPeriodId: string): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load fiscal period: ${error.message}`)
  return Boolean(data)
}

// ─────────────────────────────────────────────────────────────────
// Narrative
// ─────────────────────────────────────────────────────────────────

export async function updateArsredovisningNarrative(
  ctx: OperationContext,
  fiscalPeriodId: string,
  input: NarrativeUpdateInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<NarrativeRow>> {
  try {
    if (!(await periodBelongsToCompany(ctx, fiscalPeriodId))) return PERIOD_NOT_FOUND
    // Only 'registrerad' freezes the text. 'avslutad' (case closed WITHOUT
    // registration, e.g. withdrawn or rejected) stays editable: a refiling
    // needs amendable narrative text.
    const { data: registered, error: registeredError } = await ctx.supabase
      .from('arsredovisning_submissions')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .eq('status', 'registrerad')
      .limit(1)
      .maybeSingle()
    if (registeredError) throw new Error(`Failed to check submission status: ${registeredError.message}`)
    if (registered) return { ok: false, code: 'ARSREDOVISNING_REGISTERED' }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          fiscal_period_id: fiscalPeriodId,
          fields: Object.keys(input),
          changes: input,
          clears_narrative_confirmation: true,
        },
      }
    }

    const data = await upsertNarrative(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId, input)
    const { error: confirmationError } = await ctx.supabase
      .from('annual_report_profiles')
      .update({ narrative_confirmed_at: null })
      .eq('company_id', ctx.companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
    if (confirmationError) {
      throw new Error(`Failed to clear narrative confirmation: ${confirmationError.message}`)
    }
    return { ok: true, data }
  } catch (error) {
    return failed(error)
  }
}

// ─────────────────────────────────────────────────────────────────
// Compliance profile
// ─────────────────────────────────────────────────────────────────

export function complianceResponseData(model: CanonicalAnnualReport) {
  return {
    profile: model.profile,
    disclosures: model.disclosures,
    eligibility: model.eligibility,
    validation: model.validation,
    capabilities: getAnnualReportCapabilities(model.entity_type, model.report.accounting_framework, model.eligibility),
    report_summary: {
      proposed_dividend: model.report.forvaltningsberattelse.proposed_dividend,
      distributable_equity: model.report.forvaltningsberattelse.resultatdisposition_amounts.total,
    },
  }
}

export type ComplianceResponse = ReturnType<typeof complianceResponseData>

export async function updateArsredovisningCompliance(
  ctx: OperationContext,
  fiscalPeriodId: string,
  input: ComplianceUpdateInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<ComplianceResponse>> {
  try {
    if (!(await periodBelongsToCompany(ctx, fiscalPeriodId))) return PERIOD_NOT_FOUND
    const { narrative_confirmed, k2_assessment_confirmed, signer_roster_confirmed, ...profileFields } = input

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          fiscal_period_id: fiscalPeriodId,
          fields: Object.keys(input),
          changes: input,
          ...(profileFields.is_parent_company === false
            ? { clears: ['parent_group_size', 'prepares_consolidated_accounts'] }
            : {}),
        },
      }
    }

    const now = new Date().toISOString()
    await upsertAnnualReportProfile(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId, {
      ...profileFields,
      ...(narrative_confirmed !== undefined ? { narrative_confirmed_at: narrative_confirmed ? now : null } : {}),
      ...(k2_assessment_confirmed !== undefined
        ? { k2_assessment_confirmed_at: k2_assessment_confirmed ? now : null }
        : {}),
      ...(signer_roster_confirmed !== undefined
        ? { signer_roster_confirmed_at: signer_roster_confirmed ? now : null }
        : {}),
    })
    const model = await buildCanonicalAnnualReport(ctx.supabase, ctx.companyId, fiscalPeriodId, {
      stage: 'draft',
      includeIxbrl: false,
    })
    return { ok: true, data: complianceResponseData(model) }
  } catch (error) {
    return failed(error)
  }
}

// ─────────────────────────────────────────────────────────────────
// Versions
// ─────────────────────────────────────────────────────────────────

export interface VersionCreateOptions {
  dryRun: boolean
  /** The content hash the caller reviewed; the version is refused when the report no longer hashes to it. */
  expectedContentHash?: string
}

export async function createArsredovisningVersion(
  ctx: OperationContext,
  fiscalPeriodId: string,
  input: VersionCreateInput,
  { dryRun, expectedContentHash }: VersionCreateOptions,
): Promise<OperationOutcome<AnnualReportVersionSummary>> {
  try {
    if (!(await periodBelongsToCompany(ctx, fiscalPeriodId))) return PERIOD_NOT_FOUND
    const finalize = input.action === 'finalize'
    const signer = input.certificate_signer
    const build = () =>
      buildCanonicalAnnualReport(ctx.supabase, ctx.companyId, fiscalPeriodId, {
        stage: finalize ? 'signing' : 'draft',
        undertecknare: signer
          ? { firstName: signer.first_name, lastName: signer.last_name, role: signer.role }
          : undefined,
      })
    // Verify the complete live read before persisting anything immutable. A
    // later import cannot change this captured model: version creation and
    // signature preparation never re-read its balances. The dry run reads
    // without the lease (acquiring it writes).
    const model = dryRun ? await build() : await withSIEPeriodRead(ctx.supabase, ctx.companyId, 'report_export', build)

    if (hasStatementIntegrityErrors(model) || (finalize && !model.validation.ok)) {
      return {
        ok: false,
        code: 'ARSREDOVISNING_INCOMPLETE',
        details: model.validation as unknown as Record<string, unknown>,
      }
    }

    if (dryRun || expectedContentHash) {
      const contentHash = annualReportContentHash(model)
      if (expectedContentHash && contentHash !== expectedContentHash) {
        return {
          ok: false,
          code: 'ARSREDOVISNING_CONTENT_CHANGED',
          details: { expected_content_hash: expectedContentHash, content_hash: contentHash },
        }
      }
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          preview: {
            fiscal_period_id: fiscalPeriodId,
            action: input.action,
            status_after: finalize ? 'ready_for_signature' : 'draft',
            framework: model.report.accounting_framework,
            content_hash: contentHash,
            validation: {
              stage: model.validation.stage,
              ok: model.validation.ok,
              error_count: model.validation.error_count,
              warning_count: model.validation.warning_count,
            },
            digital_filing_eligible: model.eligibility.digital_filing_eligible,
            signer_count: model.report.signatures.length,
            ...(signer ? { certificate_signer_role: signer.role } : {}),
          },
        }
      }
    }

    // Finalizing binds the signer roster to the version through an RPC only
    // the trusted service role may call (create_annual_report_version_with_signatures).
    const data = await createAnnualReportVersion(
      finalize ? createServiceClient() : ctx.supabase,
      ctx.userId,
      model,
      finalize,
    )
    return { ok: true, data, created: true }
  } catch (error) {
    return failed(error)
  }
}

// ─────────────────────────────────────────────────────────────────
// Signer roster and signatures
// ─────────────────────────────────────────────────────────────────

export async function listArsredovisningSignatories(
  ctx: OperationContext,
  fiscalPeriodId: string,
): Promise<OperationOutcome<SignatureRequest[]>> {
  try {
    if (!(await periodBelongsToCompany(ctx, fiscalPeriodId))) return PERIOD_NOT_FOUND
    return { ok: true, data: await listSignatureRequests(ctx.supabase, ctx.companyId, fiscalPeriodId) }
  } catch (error) {
    return failed(error)
  }
}

export async function addArsredovisningSignatory(
  ctx: OperationContext,
  fiscalPeriodId: string,
  input: SignatoryCreateInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<SignatureRequest>> {
  try {
    if (!(await periodBelongsToCompany(ctx, fiscalPeriodId))) return PERIOD_NOT_FOUND
    const { data: duplicate, error: duplicateError } = await ctx.supabase
      .from('arsredovisning_signature_requests')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .eq('status', 'pending')
      .is('annual_report_version_id', null)
      .ilike('role', input.role.trim())
      .ilike('signer_name', input.signer_name.trim())
      .maybeSingle()
    if (duplicateError) {
      throw new Error(`Failed to check annual report signer roster: ${duplicateError.message}`)
    }
    if (duplicate) return { ok: false, code: 'ARSREDOVISNING_SIGNER_ALREADY_EXISTS' }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          fiscal_period_id: fiscalPeriodId,
          role: input.role,
          signer_name: input.signer_name,
          // The roster trigger clears signer_roster_confirmed_at on any change.
          clears_signer_roster_confirmation: true,
        },
      }
    }
    const data = await createSignatureRequest(ctx.supabase, ctx.companyId, ctx.userId, fiscalPeriodId, input)
    return { ok: true, data, created: true }
  } catch (error) {
    return failed(error)
  }
}

function isSignatureDateAllowed(signedAt: string, finalizedAt: string): boolean {
  const signedDate = getSwedishLocalDate(new Date(signedAt))
  const finalizedDate = getSwedishLocalDate(new Date(finalizedAt))
  const today = getSwedishLocalDate()
  return signedDate >= finalizedDate && signedDate <= today
}

/**
 * pending -> signed (evidence of a paper original or an e-signature made
 * outside the product) or pending -> declined. Every write is scoped by id,
 * company, the path's period and status 'pending', so a signed or declined
 * row cannot be flipped back and a slot of another period cannot be reached.
 */
export async function recordArsredovisningSignature(
  ctx: OperationContext,
  fiscalPeriodId: string,
  signatureId: string,
  input: SignatureTransitionInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<SignatureRequest>> {
  try {
    if (input.status === 'signed') {
      const { data: version, error: versionError } = await ctx.supabase
        .from('annual_report_versions')
        .select('id, status, finalized_at')
        .eq('id', input.annual_report_version_id)
        .eq('company_id', ctx.companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'ready_for_signature')
        .maybeSingle()
      if (versionError) throw new Error(`Failed to load annual report version: ${versionError.message}`)
      if (!version?.finalized_at) return { ok: false, code: 'ARSREDOVISNING_VERSION_NOT_SIGNABLE' }

      const { data: requestRow, error: requestError } = await ctx.supabase
        .from('arsredovisning_signature_requests')
        .select('id, annual_report_version_id, status')
        .eq('id', signatureId)
        .eq('company_id', ctx.companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .maybeSingle()
      if (requestError) throw new Error(`Failed to load annual report signature: ${requestError.message}`)
      if (
        !requestRow ||
        (requestRow.annual_report_version_id !== null &&
          requestRow.annual_report_version_id !== input.annual_report_version_id)
      ) {
        return { ok: false, code: 'SIGNATURE_INVALID_TRANSITION' }
      }
      const signedAt = input.signed_at ?? new Date().toISOString()
      if (!isSignatureDateAllowed(signedAt, version.finalized_at)) {
        return { ok: false, code: 'ARSREDOVISNING_SIGNATURE_DATE_INVALID' }
      }
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          preview: {
            signature_id: signatureId,
            fiscal_period_id: fiscalPeriodId,
            status_after: 'signed',
            annual_report_version_id: input.annual_report_version_id,
            signing_method: input.signing_method,
            evidence_reference: input.evidence_reference,
            signed_at: signedAt,
          },
        }
      }
      // The signature trigger refuses evidence written by an ordinary member
      // session; the trusted service role records it, scoped as above.
      const data = await markSignatureSigned(createServiceClient(), ctx.companyId, signatureId, {
        fiscalPeriodId,
        annualReportVersionId: input.annual_report_version_id,
        signingMethod: input.signing_method,
        evidenceReference: input.evidence_reference,
        evidenceRecordedBy: ctx.userId,
        signedAt,
      })
      return { ok: true, data }
    }

    if (dryRun) {
      const { data: pending, error: pendingError } = await ctx.supabase
        .from('arsredovisning_signature_requests')
        .select('id')
        .eq('id', signatureId)
        .eq('company_id', ctx.companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .maybeSingle()
      if (pendingError) throw new Error(`Failed to load annual report signature: ${pendingError.message}`)
      if (!pending) return { ok: false, code: 'SIGNATURE_INVALID_TRANSITION' }
      return {
        ok: true,
        dryRun: true,
        preview: { signature_id: signatureId, fiscal_period_id: fiscalPeriodId, status_after: 'declined' },
      }
    }

    const { data, error } = await createServiceClient()
      .from('arsredovisning_signature_requests')
      .update({ status: 'declined' as const })
      .eq('id', signatureId)
      .eq('company_id', ctx.companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()
    if (error) throw new Error(`Failed to update signature: ${error.message}`)
    // No row matched: it does not exist, belongs to another company or
    // period, or is already signed/declined. An invalid transition, not "missing".
    if (!data) return { ok: false, code: 'SIGNATURE_INVALID_TRANSITION' }
    return { ok: true, data: data as SignatureRequest }
  } catch (error) {
    return failed(error)
  }
}

/** Remove a pending signer slot that no version has bound yet. */
export async function removeArsredovisningSignatory(
  ctx: OperationContext,
  fiscalPeriodId: string,
  signatureId: string,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<{ signature_id: string; deleted: true }>> {
  try {
    const scoped = (client: SupabaseClient) =>
      client
        .from('arsredovisning_signature_requests')
        .select('id')
        .eq('id', signatureId)
        .eq('company_id', ctx.companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .is('annual_report_version_id', null)
        .maybeSingle()

    if (dryRun) {
      const { data, error } = await scoped(ctx.supabase)
      if (error) throw new Error(`Failed to load annual report signer: ${error.message}`)
      if (!data) return { ok: false, code: 'ARSREDOVISNING_SIGNER_ROSTER_LOCKED' }
      return {
        ok: true,
        dryRun: true,
        preview: { signature_id: signatureId, fiscal_period_id: fiscalPeriodId, clears_signer_roster_confirmation: true },
      }
    }

    const { data, error } = await ctx.supabase
      .from('arsredovisning_signature_requests')
      .delete()
      .eq('id', signatureId)
      .eq('company_id', ctx.companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .eq('status', 'pending')
      .is('annual_report_version_id', null)
      .select('id')
      .maybeSingle()
    if (error) throw new Error(`Failed to remove annual report signer: ${error.message}`)
    if (!data) return { ok: false, code: 'ARSREDOVISNING_SIGNER_ROSTER_LOCKED' }
    return { ok: true, data: { signature_id: signatureId, deleted: true } }
  } catch (error) {
    return failed(error)
  }
}
