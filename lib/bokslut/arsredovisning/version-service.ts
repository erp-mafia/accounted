import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AnnualReportVersionValidationSnapshot,
  AnnualReportVersionSummary,
  CanonicalAnnualReport,
} from './compliance-types'
import { getEntryPoint } from '@/lib/bokslut/ixbrl/taxonomy/entry-points'
import { validateStatementIntegrity } from './completeness'

export function hasStatementIntegrityErrors(model: CanonicalAnnualReport): boolean {
  return validateStatementIntegrity(model.report, model.ixbrl).length > 0
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    )
  }
  return value
}

export function annualReportContentHash(model: CanonicalAnnualReport): string {
  const reportForSigning = {
    ...model.report,
    signatures: model.report.signatures.map((signature) => ({
      role: signature.role,
      name: signature.name,
      signed_at: null,
    })),
  }
  const ixbrlForSigning = model.ixbrl
    ? {
        ...model.ixbrl,
        underskrifter: {
          ...model.ixbrl.underskrifter,
          dateringsdatum: null,
          signers: model.ixbrl.underskrifter.signers.map((signer) => ({
            ...signer,
            signedDate: null,
          })),
        },
        faststallelseintyg: {
          ...model.ixbrl.faststallelseintyg,
          genereratDatum: null,
        },
      }
    : null
  const content = {
    schema_version: model.schema_version,
    company_id: model.company_id,
    fiscal_period_id: model.fiscal_period_id,
    entity_type: model.entity_type,
    report: reportForSigning,
    profile: model.profile,
    disclosures: model.disclosures,
    ixbrl: ixbrlForSigning,
  }
  return createHash('sha256').update(JSON.stringify(stableValue(content))).digest('hex')
}

export async function listAnnualReportVersions(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<AnnualReportVersionSummary[]> {
  const { data, error } = await supabase
    .from('annual_report_versions')
    .select(
      'id, version_number, status, framework, content_hash, taxonomy_version, entry_point, finalized_at, created_at, ixbrl_data, validation_summary',
    )
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .order('version_number', { ascending: false })
  if (error) throw new Error(`Failed to list annual report versions: ${error.message}`)
  return (data ?? []).map((row) => {
    const version = row as AnnualReportVersionSummary & {
      ixbrl_data?: CanonicalAnnualReport['ixbrl']
      validation_summary?: AnnualReportVersionValidationSnapshot
    }
    const signer = version.ixbrl_data?.faststallelseintyg
    return {
      id: version.id,
      version_number: version.version_number,
      status: version.status,
      framework: version.framework,
      content_hash: version.content_hash,
      taxonomy_version: version.taxonomy_version,
      entry_point: version.entry_point,
      finalized_at: version.finalized_at,
      created_at: version.created_at,
      digital_filing_eligible:
        version.validation_summary?.digital_filing_eligible === true,
      certificate_signer: signer
        ? {
            first_name: signer.signerFirstName,
            last_name: signer.signerLastName,
            role: signer.signerRole,
          }
        : null,
    }
  })
}

export async function getAnnualReportVersion(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  versionId: string,
): Promise<{
  summary: AnnualReportVersionSummary
  report_data: CanonicalAnnualReport['report']
  ixbrl_data: CanonicalAnnualReport['ixbrl']
  validation_summary: AnnualReportVersionValidationSnapshot
} | null> {
  const { data, error } = await supabase
    .from('annual_report_versions')
    .select(
      'id, version_number, status, framework, content_hash, taxonomy_version, entry_point, finalized_at, created_at, report_data, ixbrl_data, validation_summary',
    )
    .eq('id', versionId)
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load annual report version: ${error.message}`)
  if (!data) return null
  const row = data as AnnualReportVersionSummary & {
    report_data: CanonicalAnnualReport['report']
    ixbrl_data: CanonicalAnnualReport['ixbrl']
    validation_summary: AnnualReportVersionValidationSnapshot
  }
  return {
    summary: row,
    report_data: row.report_data,
    ixbrl_data: row.ixbrl_data,
    validation_summary: row.validation_summary,
  }
}

export async function createAnnualReportVersion(
  supabase: SupabaseClient,
  userId: string,
  model: CanonicalAnnualReport,
  finalize: boolean,
): Promise<AnnualReportVersionSummary> {
  if (hasStatementIntegrityErrors(model)) {
    throw new Error('Annual report has inconsistent financial statements and cannot be versioned')
  }
  if (finalize && !model.validation.ok) {
    throw new Error('Annual report has blocking validation errors and cannot be finalized')
  }
  const hash = annualReportContentHash(model)
  const entryPoint = model.ixbrl?.entryPointId ?? null
  const taxonomyVersion = entryPoint ? getEntryPoint(entryPoint).taxonomyVersion : null
  const rpcName = finalize
    ? 'create_annual_report_version_with_signatures'
    : 'create_annual_report_version'
  const { data, error } = await supabase.rpc(rpcName, {
    p_company_id: model.company_id,
    p_fiscal_period_id: model.fiscal_period_id,
    p_schema_version: model.schema_version,
    p_framework: model.report.accounting_framework,
    p_status: finalize ? 'ready_for_signature' : 'draft',
    p_report_data: model.report,
    p_ixbrl_data: model.ixbrl,
    p_content_hash: hash,
    p_taxonomy_version: taxonomyVersion,
    p_entry_point: entryPoint,
    p_validation_summary: {
      ...model.validation,
      digital_filing_eligible: model.eligibility.digital_filing_eligible,
      digital_issues: model.eligibility.digital_issues,
      profile: model.profile,
      disclosures: model.disclosures,
      eligibility: model.eligibility,
    } satisfies AnnualReportVersionValidationSnapshot,
    p_user_id: userId,
  })
  if (error || !data) {
    throw new Error(`Failed to create annual report version: ${error?.message ?? 'unknown'}`)
  }
  const row = Array.isArray(data) ? data[0] : data
  const version = row as AnnualReportVersionSummary
  return version
}
