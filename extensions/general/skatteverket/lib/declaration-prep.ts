import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatPeriodType } from '@/types'
import { calculateVatDeclaration, resolvePeriodDates } from '@/lib/reports/vat-declaration'
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
  return formatRedovisningsperiod(periodType, year, period, fiscalYearEnd)
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

  return { redovisare, redovisningsperiod, momsuppgift }
}

/**
 * Load the AGI XML for a salary run from agi_declarations.xml_content
 * (built by app/api/salary/runs/[id]/agi/xml/route.ts via generateAGIXml),
 * alongside the formatted arbetsgivare/period strings used downstream by the
 * granskningsunderlag and kvittenser calls.
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

  if (!['review', 'approved', 'paid', 'booked'].includes(run.status)) {
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
