/**
 * Filing and year-end reports, one implementation behind every door: the
 * v1 report operations (lib/operations/filing-reports.ts), their MCP read
 * tools, the v1 file routes (SRU, CSV, eSKD) and, for the file builders, the
 * dashboard routes under /api/reports.
 *
 * Every function here READS. The generators are the dashboard's own
 * (lib/reports/ink2, ne-bilaga, periodisk-sammanstallning, vat-declaration,
 * kassaflodesanalys, bokslutsbilagor, behandlingshistorik, dimension-pnl);
 * nothing here recomputes a figure. What this layer adds is what the machine
 * doors need and a thrown Error cannot give: a 404 for a period that is not
 * the company's, a stable code for the wrong legal form, and the refusals
 * the dashboard answers before it builds a file.
 */
import JSZip from 'jszip'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import {
  generateSRUSubmission as generateInk2SruSubmission,
  getZipFilename as getInk2ZipFilename,
} from '@/lib/reports/ink2/sru-generator'
import type { INK2Declaration } from '@/lib/reports/ink2/types'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import {
  generateNESRUSubmission,
  getZipFilename as getNeZipFilename,
} from '@/lib/reports/ne-bilaga/sru-generator'
import type { NEDeclaration } from '@/lib/reports/ne-bilaga/types'
import { encodeISO88591 } from '@/lib/reports/sru-encoding'
import {
  generatePeriodiskSammanstallning,
  reconcilePsAgainstVatDeclaration,
  type PeriodiskSammanstallningReport,
  type PsPeriodType,
} from '@/lib/reports/periodisk-sammanstallning'
import { buildPeriodiskSammanstallningCsv, PsCsvBuildError } from '@/lib/reports/periodisk-sammanstallning-csv'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { buildESkdFile } from '@/lib/reports/vat-eskd-file'
import { generateKassaflodesanalys, type KassaflodesanalysReport } from '@/lib/reports/kassaflodesanalys'
import { generateBokslutsbilagor } from '@/lib/reports/bokslutsbilagor'
import {
  generateBehandlingshistorik,
  resolveUserLabelsFromProfiles,
  type BehandlingshistorikCategory,
  type BehandlingshistorikReport,
} from '@/lib/reports/behandlingshistorik'
import { currentAppVersion } from '@/lib/reports/app-version'
import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { filesIncomeReturn, resolveCompanyEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { DimensionPnlReport, MomsPeriod, VatPeriodType } from '@/types'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** A file a v1 file route streams as is. */
export interface ReportFile {
  filename: string
  contentType: string
  bytes: Uint8Array
}

export interface ReportPeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
}

/**
 * The fiscal period, scoped to the company. Service-role doors skip RLS, so
 * a period id from another company must answer 404 here, before any
 * generator reads with it.
 */
export async function loadReportPeriod(
  ctx: OperationContext,
  periodId: string,
): Promise<{ ok: true; period: ReportPeriodRow } | Failure> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed')
    .eq('id', periodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) {
    ctx.log.error('report period lookup failed', error, { periodId })
    return { ok: false, code: 'REPORT_GENERATION_FAILED' }
  }
  if (!data) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND', details: { period_id: periodId } }
  return { ok: true, period: data as ReportPeriodRow }
}

/** The company's legal form, read the way the INK2 and NE engines read it. */
async function companyEntityType(ctx: OperationContext) {
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return resolveCompanyEntityType(ctx.supabase, ctx.companyId, settings?.entity_type)
}

/** True when the company's org number is the owner's personnummer (enskild firma). */
export async function companyUsesPersonnummer(ctx: OperationContext): Promise<boolean> {
  try {
    return usesPersonnummerAsOrgNumber(await companyEntityType(ctx))
  } catch {
    // Unknown form: mask, the conservative answer for an identifier.
    return true
  }
}

function declarationFailure(ctx: OperationContext, err: unknown, report: string): Failure {
  ctx.log.error(`${report} declaration generation failed`, err as Error)
  return {
    ok: false,
    code: 'TAX_DECL_GENERATION_FAILED',
    details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
  }
}

/**
 * The two SRU files Skatteverket takes, zipped exactly as the dashboard's
 * format=sru download: INFO.SRU and BLANKETTER.SRU, ISO 8859-1 (UTF-8
 * mojibakes å/ä/ö and is rejected at upload).
 */
export async function buildSruZip(submission: { infoSru: string; blanketterSru: string }): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('INFO.SRU', encodeISO88591(submission.infoSru))
  zip.file('BLANKETTER.SRU', encodeISO88591(submission.blanketterSru))
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }))
}

// ─────────────────────────────────────────────────────────────────
// INK2 (aktiebolag)
// ─────────────────────────────────────────────────────────────────

export async function getInk2Declaration(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<INK2Declaration>> {
  const period = await loadReportPeriod(ctx, periodId)
  if (!period.ok) return period
  try {
    if (filesIncomeReturn(await companyEntityType(ctx)) !== 'INK2') return { ok: false, code: 'TAX_DECL_INK2_WRONG_LEGAL_FORM' }
    return { ok: true, data: await generateINK2Declaration(ctx.supabase, ctx.companyId, periodId) }
  } catch (err) {
    return declarationFailure(ctx, err, 'ink2')
  }
}

export async function getInk2SruFile(ctx: OperationContext, periodId: string): Promise<OperationOutcome<ReportFile>> {
  const declaration = await getInk2Declaration(ctx, periodId)
  if (!declaration.ok || declaration.dryRun) return declaration as Failure
  try {
    const bytes = await buildSruZip(generateInk2SruSubmission(declaration.data))
    return {
      ok: true,
      data: { filename: getInk2ZipFilename(declaration.data), contentType: 'application/zip', bytes },
    }
  } catch (err) {
    return declarationFailure(ctx, err, 'ink2 sru')
  }
}

// ─────────────────────────────────────────────────────────────────
// NE-bilaga (enskild firma)
// ─────────────────────────────────────────────────────────────────

export async function getNeDeclaration(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<NEDeclaration>> {
  const period = await loadReportPeriod(ctx, periodId)
  if (!period.ok) return period
  try {
    if (filesIncomeReturn(await companyEntityType(ctx)) !== 'NE') return { ok: false, code: 'TAX_DECL_NE_WRONG_LEGAL_FORM' }
    return { ok: true, data: await generateNEDeclaration(ctx.supabase, ctx.companyId, periodId) }
  } catch (err) {
    return declarationFailure(ctx, err, 'ne-bilaga')
  }
}

/** The NE SRU zip. Built from the UNMASKED declaration: the file is the filing. */
export async function getNeSruFile(ctx: OperationContext, periodId: string): Promise<OperationOutcome<ReportFile>> {
  const declaration = await getNeDeclaration(ctx, periodId)
  if (!declaration.ok || declaration.dryRun) return declaration as Failure
  try {
    const bytes = await buildSruZip(generateNESRUSubmission(declaration.data))
    return {
      ok: true,
      data: { filename: getNeZipFilename(declaration.data), contentType: 'application/zip', bytes },
    }
  } catch (err) {
    return declarationFailure(ctx, err, 'ne-bilaga sru')
  }
}

// ─────────────────────────────────────────────────────────────────
// Periodisk sammanställning (EU sales list)
// ─────────────────────────────────────────────────────────────────

export interface PsPeriodInput {
  period_type: PsPeriodType
  year: number
  period: number
}

type ReconciledPs = Awaited<ReturnType<typeof reconcilePsAgainstVatDeclaration>>

/**
 * The report plus the best-effort reconciliation against the momsdeklaration
 * when the periods coincide, exactly what GET /api/reports/periodisk-sammanstallning answers.
 */
export async function getPeriodiskSammanstallning(
  ctx: OperationContext,
  input: PsPeriodInput,
): Promise<OperationOutcome<ReconciledPs>> {
  try {
    const report = await generatePeriodiskSammanstallning(
      ctx.supabase, ctx.companyId, input.period_type, input.year, input.period,
    )
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('moms_period')
      .eq('company_id', ctx.companyId)
      .single()
    const momsPeriod = (settings?.moms_period ?? null) as MomsPeriod | null
    return { ok: true, data: await reconcilePsAgainstVatDeclaration(ctx.supabase, ctx.companyId, report, momsPeriod) }
  } catch (err) {
    ctx.log.error('periodisk sammanställning calculation failed', err as Error, { ...input })
    return {
      ok: false,
      code: 'PS_REPORT_GENERATION_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

/**
 * The SKV 574008 CSV for upload to Skatteverket. Refused while the tax
 * contact on company_settings is incomplete or the report has blocking
 * warnings, as the dashboard download is.
 */
export async function getPeriodiskSammanstallningCsv(
  ctx: OperationContext,
  input: PsPeriodInput,
): Promise<OperationOutcome<ReportFile>> {
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('org_number, tax_contact_name, tax_contact_phone, tax_contact_email')
    .eq('company_id', ctx.companyId)
    .single()
  if (
    !settings?.org_number ||
    !settings?.tax_contact_name ||
    !settings?.tax_contact_phone ||
    !settings?.tax_contact_email
  ) {
    return { ok: false, code: 'PS_REPORT_MISSING_FILER_INFO' }
  }

  let report: PeriodiskSammanstallningReport
  try {
    report = await generatePeriodiskSammanstallning(
      ctx.supabase, ctx.companyId, input.period_type, input.year, input.period,
    )
    const csv = buildPeriodiskSammanstallningCsv(report, {
      organizationNumber: settings.org_number,
      contactName: settings.tax_contact_name,
      contactPhone: settings.tax_contact_phone,
      contactEmail: settings.tax_contact_email,
    })
    return {
      ok: true,
      data: { filename: csv.filename, contentType: csv.mimeType, bytes: new Uint8Array(csv.content) },
    }
  } catch (err) {
    if (err instanceof PsCsvBuildError) {
      if (err.reason === 'BLOCKING_WARNINGS') {
        return { ok: false, code: 'PS_REPORT_CSV_BLOCKED_BY_ERRORS', details: { message: getUserErrorMessage(err) } }
      }
      if (err.reason === 'MISSING_FILER_INFO') {
        return { ok: false, code: 'PS_REPORT_MISSING_FILER_INFO', details: { message: getUserErrorMessage(err) } }
      }
    }
    ctx.log.error('periodisk sammanställning CSV failed', err as Error, { ...input })
    return {
      ok: false,
      code: 'PS_REPORT_GENERATION_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Momsdeklaration eSKD file
// ─────────────────────────────────────────────────────────────────

export interface VatPeriodInput {
  period_type: VatPeriodType
  year: number
  period: number
  /** Yearly (helårsmoms) only: the räkenskapsår whose bounds the period takes. */
  fiscal_period_id?: string
}

/**
 * The eSKDUpload (v6.0) XML the user uploads at skatteverket.se ("Deklarera
 * via fil"), computed purely from the bookkeeping. Refused without a valid
 * 10- or 12-digit org number: the header would be an "avvisande fel".
 */
export async function getVatEskdFile(
  ctx: OperationContext,
  input: VatPeriodInput,
): Promise<OperationOutcome<ReportFile>> {
  const { data: companyRow } = await ctx.supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', ctx.companyId)
    .single()
  if (!companyRow) return { ok: false, code: 'VAT_ESKD_SETTINGS_MISSING' }

  // 12-digit century-prefixed values are fine: the builder strips the prefix
  // (settings rows predating org-number normalization hold them).
  const orgDigits = (companyRow.org_number ?? '').replace(/\D/g, '')
  if (orgDigits.length !== 10 && orgDigits.length !== 12) return { ok: false, code: 'VAT_ESKD_ORG_NUMBER_INVALID' }

  if (input.fiscal_period_id) {
    const period = await loadReportPeriod(ctx, input.fiscal_period_id)
    if (!period.ok) return period
  }

  try {
    const declaration = await calculateVatDeclaration(
      ctx.supabase, ctx.companyId, input.period_type, input.year, input.period,
      { fiscalPeriodId: input.fiscal_period_id },
    )
    const xml = buildESkdFile(declaration.rutor, {
      orgNumber: companyRow.org_number,
      periodEnd: declaration.period.end,
    })
    return {
      ok: true,
      data: {
        filename: `momsdeklaration-${declaration.period.start}--${declaration.period.end}.xml`,
        contentType: 'application/xml; charset=ISO-8859-1',
        bytes: new Uint8Array(Buffer.from(xml, 'latin1')),
      },
    }
  } catch (err) {
    ctx.log.error('eSKD file generation failed', err as Error, { ...input })
    return {
      ok: false,
      code: 'VAT_REPORT_GENERATION_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Kassaflödesanalys, bokslutsbilagor, behandlingshistorik
// ─────────────────────────────────────────────────────────────────

export async function getKassaflodesanalys(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<KassaflodesanalysReport>> {
  const period = await loadReportPeriod(ctx, periodId)
  if (!period.ok) return period
  try {
    return { ok: true, data: await generateKassaflodesanalys(ctx.supabase, ctx.companyId, periodId) }
  } catch (err) {
    // The tax bridge refuses a year whose tax postings it cannot split: a
    // stable code the caller can act on, not a server fault.
    if ((err as { code?: unknown })?.code === 'CASH_FLOW_TAX_ALLOCATION_REQUIRED') {
      return { ok: false, code: 'CASH_FLOW_TAX_ALLOCATION_REQUIRED' }
    }
    ctx.log.error('kassaflödesanalys generation failed', err as Error, { periodId })
    return { ok: false, code: 'REPORT_GENERATION_FAILED' }
  }
}

type BokslutsbilagorReport = NonNullable<Awaited<ReturnType<typeof generateBokslutsbilagor>>>

/**
 * The bokslutsbilagor pärm. Signer and uploader labels resolve through the
 * service-role profiles lookup restricted to the ids in the result, like the
 * dashboard; on the machine doors ctx.supabase already is that client.
 */
export async function getBokslutsbilagor(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<BokslutsbilagorReport>> {
  try {
    const report = await generateBokslutsbilagor(ctx.supabase, ctx.companyId, periodId, {
      userId: ctx.userId,
      resolveUserLabels: (ids) => resolveUserLabelsFromProfiles(ctx.supabase, ids),
      appVersion: currentAppVersion(),
    })
    if (!report) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND', details: { period_id: periodId } }
    return { ok: true, data: report }
  } catch (err) {
    ctx.log.error('bokslutsbilagor generation failed', err as Error, { periodId })
    return { ok: false, code: 'REPORT_GENERATION_FAILED' }
  }
}

export interface BehandlingshistorikInput {
  period_id: string
  from_date?: string
  to_date?: string
  category?: BehandlingshistorikCategory
}

/**
 * Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16) for one fiscal
 * period, optionally narrowed to a sub-range inside it and to one category:
 * the same filters as GET /api/reports/behandlingshistorik.
 */
export async function getBehandlingshistorik(
  ctx: OperationContext,
  input: BehandlingshistorikInput,
): Promise<OperationOutcome<BehandlingshistorikReport>> {
  const period = await loadReportPeriod(ctx, input.period_id)
  if (!period.ok) return period
  if (input.from_date || input.to_date) {
    const params = new URLSearchParams()
    if (input.from_date) params.set('from_date', input.from_date)
    if (input.to_date) params.set('to_date', input.to_date)
    const parsed = parseReportDateRange(params, period.period)
    if (!parsed.ok) return { ok: false, code: 'VALIDATION_ERROR', messageSv: parsed.error }
  }
  try {
    const report = await generateBehandlingshistorik(
      ctx.supabase,
      ctx.companyId,
      {
        periodId: input.period_id,
        fromDate: input.from_date,
        toDate: input.to_date,
        categories: input.category ? [input.category] : undefined,
      },
      {
        resolveUserLabels: (ids) => resolveUserLabelsFromProfiles(ctx.supabase, ids),
        appVersion: currentAppVersion(),
        globalClient: ctx.supabase,
      },
    )
    if (!report) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND', details: { period_id: input.period_id } }
    return { ok: true, data: report }
  } catch (err) {
    // Raw message stays server-side: it can carry table names / SQL.
    ctx.log.error('behandlingshistorik generation failed', err as Error, { periodId: input.period_id })
    return { ok: false, code: 'REPORT_GENERATION_FAILED' }
  }
}

// ─────────────────────────────────────────────────────────────────
// Resultat per dimension
// ─────────────────────────────────────────────────────────────────

export interface DimensionPnlInput {
  period_id: string
  /** SIE dimension number, as a string: '6' projekt (default), '1' kostnadsställe. */
  dim_no: string
  to_date?: string
}

export async function getDimensionPnl(
  ctx: OperationContext,
  input: DimensionPnlInput,
): Promise<OperationOutcome<DimensionPnlReport>> {
  const period = await loadReportPeriod(ctx, input.period_id)
  if (!period.ok) return period
  if (input.to_date) {
    const parsed = parseReportDateRange(new URLSearchParams({ to_date: input.to_date }), period.period)
    if (!parsed.ok) return { ok: false, code: 'VALIDATION_ERROR', messageSv: parsed.error }
  }
  try {
    // Only toDate: the matrix is cumulative from period_start by design
    // (closing-balance semantics; see lib/reports/dimension-pnl.ts).
    const data = await generateDimensionPnl(ctx.supabase, ctx.companyId, input.period_id, input.dim_no, {
      toDate: input.to_date,
    })
    return { ok: true, data }
  } catch (err) {
    ctx.log.error('dimension pnl generation failed', err as Error, { ...input })
    return {
      ok: false,
      code: 'REPORT_GENERATION_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}
