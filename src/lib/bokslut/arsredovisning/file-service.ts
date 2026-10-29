/**
 * The årsredovisning as files, and the iXBRL pre-flight: one implementation
 * behind the dashboard routes (…/arsredovisning/pdf, /ixbrl, /ixbrl/validate)
 * and the v1 doors (lib/operations/arsredovisning.ts and the v1 file routes),
 * so both downloads are byte-identical.
 *
 *   - PDF: the live draft from the canonical model, or a frozen version
 *     (report data as versioned, with only its version-bound signatures
 *     overlaid). K3 documents render with the K3 template.
 *   - iXBRL (XHTML): the inline XBRL document of the version's entry point
 *     (K2 AB risbs, or K3 AB risbs while the K3 document is switched on),
 *     live or from a version.
 *   - validate: layer-1 pre-flight (the local mirror of Bolagsverket's
 *     kontrollera rules) plus a generation dry run, so a document that cannot
 *     be generated is an issue, not an error.
 *
 * Live reads can hold the SIE import read lease (`leaseLiveRead`): a file
 * must never be rendered from a half-imported ledger. The dashboard routes
 * already hold it through withRouteContext's requireCompleteLedger and pass
 * false. Frozen versions stay readable during an import: their figures were
 * captured from a complete read when the version was made.
 *
 * Nothing here sends anything to Bolagsverket.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { ReportFile } from '@/lib/reports/filing-report-service'
import { withSIEPeriodRead } from '@/lib/import/sie-period-read'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateIxbrlDocument } from '@/lib/bokslut/ixbrl/document/generate'
import { runPreflightChecks, type PreflightIssue } from '@/lib/bokslut/ixbrl/validate/rules'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
import { buildCanonicalAnnualReport } from './model'
import { getAnnualReportVersion } from './version-service'
import { getVersionIxbrlInput } from './version-ixbrl'
import { getAnnualReportProfile } from './profile-service'
import type { AnnualReportProfile } from './compliance-types'
import { pdfModeForVersionStatus, type ArsredovisningPdfMode } from './signature-pages'
import type { ArsredovisningData } from './types'
import { versionPateckningFacts, type VersionPateckningRow } from '@/lib/bokslut/ixbrl/revisorspateckning'
import { isAuditorRole } from './workflow-schemas'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

export interface ArsredovisningFileQuery {
  fiscal_period_id: string
  /** A frozen version (annual_report_versions.id); omit for the live draft. */
  version_id?: string
  /** iXBRL only: proposed dividend in whole SEK for the resultatdisposition (live draft only). */
  proposed_dividend?: number
}

export interface ArsredovisningFile extends ReportFile {
  /** The version the file was rendered from, when one was asked for. */
  versionId: string | null
  /** iXBRL only: how many generation warnings the document carries. */
  warningCount?: number
}

export interface FileOptions {
  /** Hold the SIE import read lease around a live build and render. */
  leaseLiveRead: boolean
}

function failed(error: unknown): Failure {
  const message = error instanceof Error ? error.message : ''
  if (/not found/i.test(message)) return { ok: false, code: 'PERIOD_NOT_FOUND' }
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

function leased<T>(ctx: OperationContext, lease: boolean, read: () => Promise<T>): Promise<T> {
  return lease ? withSIEPeriodRead(ctx.supabase, ctx.companyId, 'report_export', read) : read()
}

/**
 * One of the PDF renders (signature-pages.ts) of report data. React-pdf and
 * the templates load here, not with every route that reaches this module
 * through the operations registry.
 */
async function renderArsredovisningPdf(data: ArsredovisningData, mode: ArsredovisningPdfMode): Promise<Uint8Array> {
  const [{ renderToBuffer }, { ArsredovisningPDF }, { ArsredovisningK3PDF }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./arsredovisning-pdf'),
    import('./arsredovisning-k3-pdf'),
  ])
  const PdfComponent = data.accounting_framework === 'k3' ? ArsredovisningK3PDF : ArsredovisningPDF
  return new Uint8Array(await renderToBuffer(PdfComponent({ data, mode })))
}

/**
 * The live draft's revisorspåteckning facts, as the profile holds them now:
 * the revisor gives them after the board signed. A locked version reads
 * versionPateckning instead.
 */
function withAuditorPateckning(data: ArsredovisningData, profile: AnnualReportProfile): ArsredovisningData {
  data.auditor_pateckning = {
    required: profile.auditor_report_required === true,
    firm_name: profile.auditor_firm_name?.trim() || null,
    opinion: profile.auditor_opinion ?? null,
  }
  return data
}

/**
 * A locked version's report data with what is given after the lock put on
 * top, and nothing else, so the version renders as it was signed (BFL 7
 * kap. 1 §): its version-bound signer slots (role, name, signed_at) and, only
 * when the version itself carries a revisor slot, the revisorspåteckning,
 * with the opinion and revisionsbolag frozen on the signed revisor slots
 * (versionPateckningFacts). A version without a revisor slot renders no
 * påteckning, whatever the profile says now.
 */
async function versionReportWithSignatures(ctx: OperationContext, fiscalPeriodId: string, versionId: string) {
  const version = await getAnnualReportVersion(ctx.supabase, ctx.companyId, fiscalPeriodId, versionId)
  if (!version) return null
  const data = structuredClone(version.report_data)
  const { data: signatureRows, error: signatureError } = await ctx.supabase
    .from('arsredovisning_signature_requests')
    .select('role, signer_name, signed_at, pateckning_opinion, pateckning_firm_name')
    .eq('company_id', ctx.companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('annual_report_version_id', versionId)
    .order('created_at', { ascending: true })
  if (signatureError) throw new Error(`Failed to load version signatures: ${signatureError.message}`)
  const rows = (signatureRows ?? []) as Array<VersionPateckningRow & { signer_name: string }>
  data.signatures = rows.map((signature) => ({
    role: signature.role,
    name: signature.signer_name,
    signed_at: signature.signed_at,
  }))
  const revisorer = rows.filter((row) => isAuditorRole(row.role))
  // The profile matters only while a revisor slot is pending.
  const profile = revisorer.length > 0 && revisorer.some((row) => !row.signed_at)
    ? await getAnnualReportProfile(ctx.supabase, ctx.companyId, fiscalPeriodId)
    : null
  const facts = versionPateckningFacts(rows, profile)
  if (facts) {
    data.auditor_pateckning = { required: true, firm_name: facts.firmName, opinion: facts.opinion }
  } else {
    delete data.auditor_pateckning
  }
  return { version, data }
}

/**
 * The copy of a locked version the board signs with BankID (render
 * 'e_signing'): no dates and no lines to fill in, so the bytes do not change
 * as signatures land. Only a version waiting for signatures.
 */
export async function getArsredovisningESigningPdf(
  ctx: OperationContext,
  query: { fiscal_period_id: string; version_id: string },
): Promise<OperationOutcome<ArsredovisningFile>> {
  try {
    const loaded = await versionReportWithSignatures(ctx, query.fiscal_period_id, query.version_id)
    if (!loaded) return { ok: false, code: 'NOT_FOUND' }
    if (loaded.version.summary.status !== 'ready_for_signature') return { ok: false, code: 'SIGNING_SUBJECT_CHANGED' }
    const safePeriodEnd = loaded.data.fiscal_period.period_end.replace(/[^\w.-]/g, '_')
    return {
      ok: true,
      data: {
        filename: `arsredovisning-${safePeriodEnd}-for-signering.pdf`,
        contentType: 'application/pdf',
        bytes: await renderArsredovisningPdf(loaded.data, 'e_signing'),
        versionId: query.version_id,
      },
    }
  } catch (error) {
    return failed(error)
  }
}

export async function getArsredovisningPdfFile(
  ctx: OperationContext,
  query: ArsredovisningFileQuery,
  options: FileOptions,
): Promise<OperationOutcome<ArsredovisningFile>> {
  const { fiscal_period_id: fiscalPeriodId, version_id: versionId } = query
  try {
    const render = async (data: ArsredovisningData, versionStatus: string | null) => {
      // react-pdf and the templates load here, not with every route that
      // reaches this module through the operations registry.
      const [{ renderToBuffer }, { ArsredovisningPDF }, { ArsredovisningK3PDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./arsredovisning-pdf'),
        import('./arsredovisning-k3-pdf'),
      ])
      // K3 documents need the kassaflöde + equity-changes pages and the
      // richer noter; K2 (the default) keeps its template unchanged.
      const PdfComponent = data.accounting_framework === 'k3' ? ArsredovisningK3PDF : ArsredovisningPDF
      // Only a version locked for signature prints blank signature and
      // intyg lines to fill in by hand; the live draft and versionsutkast
      // explain those pages instead (crm#1171, crm#1172).
      const bytes = await renderToBuffer(PdfComponent({ data, mode: pdfModeForVersionStatus(versionStatus) }))
      // "-utkast" until the version is signed; sanitised so a stray quote or
      // newline in the date can never break the header.
      const safePeriodEnd = data.fiscal_period.period_end.replace(/[^\w.-]/g, '_')
      const suffix =
        versionStatus && ['signed', 'filed', 'registered'].includes(versionStatus) ? 'papperskopia' : 'utkast'
      return {
        filename: `arsredovisning-${safePeriodEnd}-${suffix}.pdf`,
        contentType: 'application/pdf',
        bytes: new Uint8Array(bytes),
        versionId: versionId ?? null,
      }
    }

    if (versionId) {
      const loaded = await versionReportWithSignatures(ctx, fiscalPeriodId, versionId)
      if (!loaded) return { ok: false, code: 'NOT_FOUND' }
      return { ok: true, data: await render(loaded.data, loaded.version.summary.status) }
    }

    const file = await leased(ctx, options.leaseLiveRead, async () => {
      const model = await buildCanonicalAnnualReport(ctx.supabase, ctx.companyId, fiscalPeriodId, {
        stage: 'draft',
        includeIxbrl: false,
      })
      return render(withAuditorPateckning(model.report, model.profile), null)
    })
    return { ok: true, data: file }
  } catch (error) {
    return failed(error)
  }
}

async function loadIxbrlInput(
  ctx: OperationContext,
  query: ArsredovisningFileQuery,
): Promise<IxbrlArsredovisningInput | null> {
  const dividend = query.proposed_dividend
  return query.version_id
    ? getVersionIxbrlInput(ctx.supabase, ctx.companyId, query.fiscal_period_id, query.version_id)
    : buildIxbrlInput(ctx.supabase, ctx.companyId, query.fiscal_period_id, {
        proposedDividend: dividend !== undefined && Number.isFinite(dividend) ? dividend : undefined,
      })
}

export async function getArsredovisningIxbrlFile(
  ctx: OperationContext,
  query: ArsredovisningFileQuery,
  options: FileOptions,
): Promise<OperationOutcome<ArsredovisningFile>> {
  try {
    const produce = async (): Promise<OperationOutcome<ArsredovisningFile>> => {
      const input = await loadIxbrlInput(ctx, query)
      if (!input) return { ok: false, code: 'NOT_FOUND' }
      const { xhtml, warnings } = generateIxbrlDocument(input)
      const safePeriodEnd = input.period.end.replace(/[^\w.-]/g, '_')
      return {
        ok: true,
        data: {
          filename: `arsredovisning-${safePeriodEnd}.xhtml`,
          contentType: 'application/xhtml+xml; charset=utf-8',
          bytes: new TextEncoder().encode(xhtml),
          versionId: query.version_id ?? null,
          warningCount: warnings.length,
        },
      }
    }
    return await leased(ctx, options.leaseLiveRead && !query.version_id, produce)
  } catch (error) {
    return failed(error)
  }
}

export interface IxbrlValidation {
  ok: boolean
  issues: PreflightIssue[]
  error_count: number
  warning_count: number
  generated_bytes: number
  entry_point: string
  period: { start: string; end: string }
  annual_report_version_id: string | null
}

/** Bolagsverket's maximum iXBRL document size. */
const MAX_IXBRL_BYTES = 5 * 1024 * 1024

export async function validateArsredovisningIxbrl(
  ctx: OperationContext,
  query: ArsredovisningFileQuery,
): Promise<OperationOutcome<IxbrlValidation>> {
  try {
    const input = await loadIxbrlInput(ctx, query)
    if (!input) return { ok: false, code: 'NOT_FOUND' }
    const result = runPreflightChecks(input)

    // Generation dry run: a document that cannot even be generated must
    // block, with the reason in the issue list rather than a raw error.
    const issues: PreflightIssue[] = [...result.issues]
    let generatedBytes = 0
    try {
      const { xhtml } = generateIxbrlDocument(input)
      generatedBytes = Buffer.byteLength(xhtml, 'utf8')
      if (generatedBytes >= MAX_IXBRL_BYTES) {
        issues.push({ code: '5006', severity: 'error', message: 'Dokumentet överstiger Bolagsverkets maxstorlek 5 MB.' })
      }
    } catch (genErr) {
      issues.push({
        code: 'ACC-GEN',
        severity: 'error',
        message: `iXBRL-dokumentet kunde inte genereras: ${genErr instanceof Error ? getUserErrorMessage(genErr) : 'okänt fel'}`,
      })
    }

    const errors = issues.filter((issue) => issue.severity === 'error')
    return {
      ok: true,
      data: {
        ok: errors.length === 0,
        issues,
        error_count: errors.length,
        warning_count: issues.length - errors.length,
        generated_bytes: generatedBytes,
        entry_point: input.entryPointId,
        period: input.period,
        annual_report_version_id: query.version_id ?? null,
      },
    }
  } catch (error) {
    return failed(error)
  }
}
