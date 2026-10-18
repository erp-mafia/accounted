import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatDeclaration, VatPeriodType } from '@/types'
import { calculateVatDeclaration, resolvePeriodDates } from '@/lib/reports/vat-declaration'
import { generateAgiDeclaration } from '@/lib/salary/agi/generate-declaration'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { createLogger } from '@/lib/logger'
import { rutorToMomsuppgift, formatRedovisare, formatRedovisningsperiod } from './mappers'
import type { SkatteverketMomsuppgift } from '../types'

/**
 * Request-free Skatteverket declaration prep.
 *
 * These functions are the single source of truth for what gets filed to
 * Skatteverket. They are shared by the HTTP route handlers
 * (parseDeclarationRequest / loadAGIXml) and the commit-side services
 * (commitSubmitVatDeclaration / commitSubmitAgi) so the numbers and XML
 * computed at preview time match exactly what is filed at commit time.
 *
 * Compliance-critical: drift between the two paths would mean different
 * figures filed to SKV than the user reviewed. Keep these the only place that
 * computes momsuppgift / loads AGI XML.
 */

export interface VatDeclarationPrep {
  redovisare: string
  redovisningsperiod: string
  momsuppgift: SkatteverketMomsuppgift
  /**
   * The declaration the momsuppgift was mapped from. Every filing path hands
   * it to vatFilingVerdict (lib/reports/vat-close-check.ts) before its first
   * Skatteverket call, so the verdict judges exactly the figures filed.
   */
  declaration: VatDeclaration
}

export interface AgiUnderlagPrep {
  arbetsgivare: string
  period: string // YYYYMM
  salaryRunId: string
  xml: string
  periodYear: number
  periodMonth: number
}

/**
 * Resolve a company's 12-digit "redovisare" string from company_settings.
 * Shared by the VAT and AGI paths and by the status tools that only need the
 * identifier (no momsuppgift / XML compute).
 */
export async function resolveRedovisare(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string> {
  const { data: settings } = await supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', companyId)
    .single()

  if (!settings?.org_number) {
    throw new Error('Organisationsnummer saknas i företagsinställningar')
  }

  return formatRedovisare(settings.org_number, settings.entity_type)
}

/** YYYYMM, the only shape Skatteverket accepts as a redovisningsperiod. */
const REDOVISNINGSPERIOD = /^(19|20)\d{2}(0[1-9]|1[0-2])$/

/**
 * The Skatteverket redovisningsperiod (YYYYMM) a VAT period files under.
 *
 * Helårsmoms is filed per räkenskapsår (SFL 26 kap 10-11 §§): the SKV period
 * is the FY-end month, which for a broken fiscal year is not December. This is
 * the ONE place that resolution happens, shared by validate/submit
 * (buildMomsuppgift), the HTTP status service and the MCP status tool. The MCP
 * tool used to inline formatRedovisningsperiod without the fiscal-year end and
 * answered 202612 for a räkenskapsår 2025-04-01..2026-03-31 (feedback seq
 * 330091) while submit had filed under 202603. Monthly and quarterly are
 * calendar periods by law, so they never touch fiscal_periods.
 */
export async function resolveRedovisningsperiod(
  supabase: SupabaseClient,
  companyId: string,
  input: { periodType: VatPeriodType; year: number; period: number; fiscalPeriodId?: string },
): Promise<string> {
  const { periodType, year, period, fiscalPeriodId } = input
  let fiscalYearEnd: { year: number; month: number } | undefined
  if (periodType === 'yearly') {
    const { end } = await resolvePeriodDates(
      supabase, companyId, periodType, year, period, fiscalPeriodId,
    )
    fiscalYearEnd = { year: Number(end.slice(0, 4)), month: Number(end.slice(5, 7)) }
  }
  const redovisningsperiod = formatRedovisningsperiod(periodType, year, period, fiscalYearEnd)
  // Last line of defence before the value becomes a Skatteverket URL segment:
  // an unchecked caller once sent "undefinedundefined" (7 requests, all 400).
  if (!REDOVISNINGSPERIOD.test(redovisningsperiod)) {
    throw Object.assign(
      new Error(
        `Ogiltig redovisningsperiod "${redovisningsperiod}" för period_type=${String(periodType)}, year=${String(year)}, period=${String(period)}`,
      ),
      { code: 'VALIDATION_ERROR' },
    )
  }
  return redovisningsperiod
}

/**
 * Compute the momsuppgift filed to SKV for a period, from the general ledger.
 * Body lifted verbatim from the former parseDeclarationRequest so route and
 * commit paths produce identical payloads.
 */
export async function buildMomsuppgift(
  supabase: SupabaseClient,
  companyId: string,
  input: { periodType: VatPeriodType; year: number; period: number; fiscalPeriodId?: string },
): Promise<VatDeclarationPrep> {
  const { periodType, year, period, fiscalPeriodId } = input

  const redovisare = await resolveRedovisare(supabase, companyId)

  // Same räkenskapsår for the period identifier and the figures below.
  const redovisningsperiod = await resolveRedovisningsperiod(supabase, companyId, input)

  // Calculate VAT declaration from the general ledger
  const declaration = await calculateVatDeclaration(
    supabase,
    companyId,
    periodType,
    year,
    period,
    { fiscalPeriodId },
  )

  const momsuppgift = rutorToMomsuppgift(declaration.rutor)

  return { redovisare, redovisningsperiod, momsuppgift, declaration }
}

/** Salary run statuses an AGI may be submitted from (finalised payroll only). */
const AGI_SUBMITTABLE_RUN_STATUSES: readonly string[] = ['review', 'approved', 'paid', 'booked']

/** agi_declarations statuses that carry Skatteverket's filing receipt. */
const AGI_RECEIPT_STATUSES: readonly string[] = ['submitted', 'accepted']

const agiRefreshLog = createLogger('skatteverket/agi-refresh')

export type AgiRefreshResult =
  | {
      ok: true
      /**
       * replaced: the fresh generation differed and is now the stored
       * underlag; unchanged: the stored underlag already matched; filed: the
       * run's declaration carries its kvittens and is left alone; skipped:
       * nothing to refresh (no such run, or not submittable: buildAgiUnderlag
       * refuses it).
       */
      outcome: 'replaced' | 'unchanged' | 'filed' | 'skipped'
    }
  | {
      ok: false
      code: string
      httpStatus: number
      error: string
      details?: Record<string, unknown>
    }

function epochOf(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Whether the run's declaration is already filed. The run's own kvittens
 * stamp (agi_submitted_at) is authoritative. Without it, a receipt on the row
 * counts only when it is not older than the run's XML: a correction run that
 * took over the original's filed row before the generator reset its filing
 * state kept that original's status and kvittens, and its own declaration is
 * still unfiled.
 */
function agiFiledForRun(
  run: { agi_submitted_at: string | null; agi_generated_at: string | null },
  declaration: { status: string; submitted_at: string | null } | null,
): boolean {
  if (run.agi_submitted_at) return true
  if (!declaration || !AGI_RECEIPT_STATUSES.includes(declaration.status)) return false
  const receiptAt = epochOf(declaration.submitted_at)
  const generatedAt = epochOf(run.agi_generated_at)
  return receiptAt === null || generatedAt === null || receiptAt >= generatedAt
}

/**
 * Bring the run's stored AGI underlag up to date before it is posted to
 * Skatteverket. Every submit path (the panel's one-click chain and its
 * advanced "Skicka in underlag", and MCP gnubok_agi_submit at approval) runs
 * this through submitAgiUnderlag, so what is filed is what the generator
 * produces from today's data, never an XML stored before a generator fix
 * (crm#1265: FK001 missing on an IU without withheld tax).
 *
 * The run's declaration is regenerated through the one generator
 * (generateAgiDeclaration, with all its refusals) unless it is already filed:
 * a filed declaration is never touched, and a correction after filing goes
 * through a correction run. When the fresh generation says the same as the
 * stored one nothing is written; when it differs the fresh one replaces the
 * stored one (logged) and is what buildAgiUnderlag then reads and posts, so
 * the stored XML is always the XML that was sent.
 */
export async function refreshAgiUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  salaryRunId: string,
): Promise<AgiRefreshResult> {
  if (!salaryRunId) return { ok: true, outcome: 'skipped' }

  const { data: run } = await supabase
    .from('salary_runs')
    .select('status, agi_generated_at, agi_submitted_at')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()
  const runRow = run as { status: string; agi_generated_at: string | null; agi_submitted_at: string | null } | null
  if (!runRow || !AGI_SUBMITTABLE_RUN_STATUSES.includes(runRow.status)) {
    return { ok: true, outcome: 'skipped' }
  }
  if (runRow.agi_submitted_at) return { ok: true, outcome: 'filed' }

  const { data: declaration } = await supabase
    .from('agi_declarations')
    .select('id, status, submitted_at')
    .eq('company_id', companyId)
    .eq('salary_run_id', salaryRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const declarationRow = declaration as { id: string; status: string; submitted_at: string | null } | null
  if (agiFiledForRun(runRow, declarationRow)) return { ok: true, outcome: 'filed' }

  const result = await generateAgiDeclaration({
    supabase,
    companyId,
    userId,
    // The contact e-mail falls back to the profile's; a session e-mail is
    // not available on every submit path (MCP approval).
    userEmail: null,
    salaryRunId,
    log: agiRefreshLog,
    requestId: randomUUID(),
    writeOnlyIfChanged: true,
  })
  if (!result.ok) {
    const details =
      typeof result.details === 'object' && result.details !== null
        ? (result.details as Record<string, unknown>)
        : undefined
    const entry = getErrorEntry(result.code)
    const message =
      typeof details?.message === 'string'
        ? details.message
        : entry?.message_sv ?? `AGI kunde inte genereras (${result.code}).`
    return {
      ok: false,
      code: result.code,
      httpStatus: result.status ?? entry?.httpStatus ?? 500,
      error: message,
      ...(details ? { details } : {}),
    }
  }
  if (result.unchanged) return { ok: true, outcome: 'unchanged' }

  agiRefreshLog.info('AGI underlag regenerated before submit: stored XML replaced', {
    companyId,
    salaryRunId,
    agiDeclarationId: result.agiDeclarationId,
    previousDeclarationId: declarationRow?.id ?? null,
    previousStatus: declarationRow?.status ?? null,
  })
  return { ok: true, outcome: 'replaced' }
}

/**
 * Load the AGI XML for a salary run from agi_declarations.xml_content
 * (built by generateAgiDeclaration, lib/salary/agi/generate-declaration.ts),
 * alongside the formatted arbetsgivare/period strings used downstream by the
 * granskningsunderlag and kvittenser calls. The submit paths run
 * refreshAgiUnderlag first, so the stored XML is current when it is posted.
 *
 * Body lifted verbatim from the former loadAGIXml: including the salary-run
 * status guard (per BFL 5 kap and SFL 26 kap, AGI must reflect finalised
 * payroll data; submitting from a draft/cancelled run would emit incorrect
 * figures and require a costly rättelse).
 */
export async function buildAgiUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<AgiUnderlagPrep> {
  if (!salaryRunId) {
    throw new Error('Saknar obligatoriskt fält: salaryRunId')
  }

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('status')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    throw new Error('Lönekörning hittades inte')
  }

  if (!AGI_SUBMITTABLE_RUN_STATUSES.includes(run.status)) {
    throw new Error('AGI kan bara skickas till Skatteverket efter granskning')
  }

  const arbetsgivare = await resolveRedovisare(supabase, companyId)

  // Use the most recent agi_declarations row for this salary run: covers
  // both new declarations and corrections (which overwrite xml_content
  // in place per the existing /api/salary/runs/[id]/agi/xml route).
  const { data: declaration, error: declarationError } = await supabase
    .from('agi_declarations')
    .select('xml_content, period_year, period_month')
    .eq('company_id', companyId)
    .eq('salary_run_id', salaryRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (declarationError || !declaration?.xml_content) {
    throw new Error(
      'AGI-XML saknas. Generera AGI-filen först: knappen "Lämna in till Skatteverket" på lönekörningen gör det automatiskt, eller klicka "Ladda ner AGI-fil".',
    )
  }

  const period = formatRedovisningsperiod('monthly', declaration.period_year, declaration.period_month)

  return {
    arbetsgivare,
    period,
    salaryRunId,
    xml: declaration.xml_content,
    periodYear: declaration.period_year,
    periodMonth: declaration.period_month,
  }
}
