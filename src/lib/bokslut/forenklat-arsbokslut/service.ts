import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchTrialBalanceChart, generateTrialBalance } from '@/lib/reports/trial-balance'
import type { TrialBalanceChartAccount } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import {
  legalFormGlossary,
  preparesForenklatArsbokslut,
  resolveCompanyEntityType,
  resultClosingAccounts,
} from '@/lib/company/entity-type'
import type { LegalFormProfile } from '@/lib/company/forms'
import type { ReportFile } from '@/lib/reports/filing-report-service'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { computeForenklatArsbokslut } from './engine'
import {
  getForenklatArsbokslutInputs,
  saveForenklatArsbokslutInputs,
  type ForenklatArsbokslutInputs,
  type ForenklatArsbokslutInputsUpdate,
  type ForenklatArsbokslutSignatory,
} from './inputs-service'
import type { K1Amounts, K1Check, K1StatementRow, K1YearBalances } from './types'

/**
 * The förenklat årsbokslut of a räkenskapsår, one implementation behind
 * every door: the dashboard routes under
 * /api/bookkeeping/fiscal-periods/[id]/forenklat-arsbokslut, the v1 report
 * operation and its MCP read (lib/operations/forenklat-arsbokslut.ts) and the
 * v1 PDF route. Read-only: it reads the closed books and the stored inputs.
 *
 * Which form gets it is a profile capability (preparesForenklatArsbokslut):
 * an ideell förening under BFNAR 2010:1 today. The figures come from
 * engine.ts; this module loads the books, adds the checks that need more than
 * the trial balance (the eligibility confirmation, invoiced medlemsavgifter)
 * and renders the PDF.
 */

/** BFNAR 2010:1: the only allmänt råd modelled. */
export type ForenklatArsbokslutRegelverk = NonNullable<LegalFormProfile['filings']['forenklatArsbokslut']>

/** BAS sub-account the förening's chart seeds for medlemsavgifter (migration 20261015180200). */
export const MEMBER_FEE_ACCOUNT = '3901'

export interface ForenklatArsbokslutPeriod {
  fiscal_period_id: string
  name: string
  period_start: string
  period_end: string
}

export interface ForenklatArsbokslut {
  regelverk: ForenklatArsbokslutRegelverk
  company: { name: string; org_number: string | null }
  fiscal_period: ForenklatArsbokslutPeriod & { is_closed: boolean }
  /** The comparison year, or null in the first year (or when it could not be read: see warnings). */
  previous_period: ForenklatArsbokslutPeriod | null
  resultatrakning: K1StatementRow[]
  balansrakning: K1StatementRow[]
  totals: {
    aretsOverUnderskott: K1Amounts
    summaTillgangar: K1Amounts
    summaEgetKapitalOchSkulder: K1Amounts
    nettoomsattning: K1Amounts
  }
  eligibility: { confirmed: boolean; confirmed_at: string | null }
  notes: string | null
  signatories: ForenklatArsbokslutSignatory[]
  /** Why the PDF is refused; empty when it can be made. */
  blockers: K1Check[]
  warnings: K1Check[]
}

export class ForenklatArsbokslutWrongFormError extends Error {
  constructor() {
    super('The company\'s legal form does not prepare a förenklat årsbokslut')
    this.name = 'ForenklatArsbokslutWrongFormError'
  }
}

export class ForenklatArsbokslutPeriodNotFoundError extends Error {
  constructor() {
    super('Fiscal period not found')
    this.name = 'ForenklatArsbokslutPeriodNotFoundError'
  }
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  previous_period_id: string | null
}

const PERIOD_COLUMNS = 'id, name, period_start, period_end, is_closed, previous_period_id'

async function yearBalances(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  chart: Promise<TrialBalanceChartAccount[]>,
): Promise<K1YearBalances> {
  // The balansräkning reads the books with the resultatavslut, the
  // resultaträkning without it ('exclude-final'): booked avskrivningar,
  // bokslutsdispositioner and skatt stay on the form.
  const [full, preClosing] = await Promise.all([
    generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'include', chart }),
    generateTrialBalance(supabase, companyId, periodId, { closingEntry: 'exclude-final', chart }),
  ])
  return { full: full.rows, preClosing: preClosing.rows }
}

/**
 * Customer invoices unpaid on the balansdag that carry a medlemsavgift line:
 * a medlemsavgift is income when paid and never a kundfordran (BFNAR 2010:1
 * 6.48, 7.1). Read from the kundreskontra as of the balansdag.
 */
async function openMemberFeeInvoices(
  supabase: SupabaseClient,
  companyId: string,
  balansdag: string,
): Promise<string[]> {
  const ledger = await generateARLedger(supabase, companyId, balansdag)
  const open = ledger.entries.flatMap((entry) =>
    entry.invoices.map((invoice) => ({ id: invoice.invoice_id, number: invoice.invoice_number })),
  )
  if (open.length === 0) return []
  const withFees = new Set<string>()
  for (let i = 0; i < open.length; i += 200) {
    const ids = open.slice(i, i + 200).map((invoice) => invoice.id)
    const rows = await fetchAllRows<{ invoice_id: string }>(({ from, to }) =>
      supabase
        .from('invoice_items')
        .select('invoice_id')
        .in('invoice_id', ids)
        .eq('revenue_account', MEMBER_FEE_ACCOUNT)
        .order('invoice_id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) withFees.add(row.invoice_id)
  }
  return open.filter((invoice) => withFees.has(invoice.id)).map((invoice) => invoice.number)
}

function memberFeeReceivablesWarning(invoiceNumbers: string[]): K1Check {
  const shown = invoiceNumbers.slice(0, 5).join(', ')
  const more = invoiceNumbers.length > 5 ? ` och ${invoiceNumbers.length - 5} till` : ''
  return {
    code: 'MEMBER_FEE_RECEIVABLES',
    message:
      `${invoiceNumbers.length === 1 ? 'Faktura' : 'Fakturorna'} ${shown}${more} med medlemsavgift (konto ` +
      `${MEMBER_FEE_ACCOUNT}) var obetald${invoiceNumbers.length === 1 ? '' : 'a'} på balansdagen. En medlemsavgift ` +
      'tas inte upp som kundfordran och är intäkt först när den betalas (BFNAR 2010:1 punkterna 6.48 och 7.1). ' +
      'Kontrollera kundfordringarna och medlemsavgifterna.',
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

const ELIGIBILITY_BLOCKER: K1Check = {
  code: 'ELIGIBILITY_NOT_CONFIRMED',
  message:
    'Bekräfta att föreningen får upprätta förenklat årsbokslut: nettoomsättningen med medlemsavgifter, gåvor och ' +
    'bidrag är normalt högst tre miljoner kronor, föreningen är inte moderföretag i en koncern och årsbokslutet ' +
    'omfattar alla föreningens verksamheter (BFL 6 kap. 3 §, BFNAR 2010:1 punkterna 1.1 och 1.2).',
}

/** Build the förenklat årsbokslut for a räkenskapsår. Throws on a period that is not the company's or the wrong form. */
export async function buildForenklatArsbokslut(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<ForenklatArsbokslut> {
  const chart = fetchTrialBalanceChart(supabase, companyId)
  // Read alongside the period; a failure surfaces where the balances await it,
  // not as an unhandled rejection when the period turns out to be foreign.
  chart.catch(() => undefined)
  const [periodResult, settingsResult, inputs] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, previous_period_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase.from('company_settings').select('company_name, org_number, entity_type').eq('company_id', companyId).maybeSingle(),
    getForenklatArsbokslutInputs(supabase, companyId, fiscalPeriodId),
  ])
  if (periodResult.error) throw periodResult.error
  if (!periodResult.data) throw new ForenklatArsbokslutPeriodNotFoundError()
  if (settingsResult.error) throw settingsResult.error
  const period = periodResult.data as PeriodRow
  const settings = settingsResult.data as { company_name?: string | null; org_number?: string | null; entity_type?: unknown } | null

  const form = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  const regelverk = preparesForenklatArsbokslut(form)
  if (!regelverk) throw new ForenklatArsbokslutWrongFormError()

  const [current, previousRow] = await Promise.all([
    yearBalances(supabase, companyId, fiscalPeriodId, chart),
    resolvePreviousFiscalPeriod<PeriodRow>(supabase, companyId, period, PERIOD_COLUMNS),
  ])

  // A comparison year that cannot be read downgrades to a warning: the
  // document is still the year's figures, and the warning says what is missing.
  let previous: K1YearBalances | null = null
  let previousUnavailable = false
  if (previousRow) {
    try {
      previous = await yearBalances(supabase, companyId, previousRow.id, chart)
    } catch {
      previousUnavailable = true
    }
  }

  const computed = computeForenklatArsbokslut({
    current,
    previous,
    previousUnavailable,
    isClosed: period.is_closed,
    closingAccount: resultClosingAccounts(form).closing,
  })

  const warnings = [...computed.warnings]
  try {
    const invoices = await openMemberFeeInvoices(supabase, companyId, period.period_end)
    if (invoices.length > 0) warnings.push(memberFeeReceivablesWarning(invoices))
  } catch {
    warnings.push({
      code: 'MEMBER_FEE_RECEIVABLES',
      message:
        'Kundreskontran kunde inte läsas, så det gick inte att kontrollera att inga obetalda medlemsavgifter ' +
        'ligger bland kundfordringarna (BFNAR 2010:1 punkt 6.48). Kontrollera dem manuellt.',
    })
  }

  const confirmed = inputs.eligibility_confirmed_at !== null
  const blockers = confirmed ? computed.blockers : [...computed.blockers, ELIGIBILITY_BLOCKER]

  return {
    regelverk,
    company: {
      name: settings?.company_name?.trim() || capitalize(legalFormGlossary(form).entity),
      org_number: settings?.org_number ?? null,
    },
    fiscal_period: {
      fiscal_period_id: period.id,
      name: period.name,
      period_start: period.period_start,
      period_end: period.period_end,
      is_closed: period.is_closed,
    },
    previous_period:
      previousRow && previous
        ? {
            fiscal_period_id: previousRow.id,
            name: previousRow.name,
            period_start: previousRow.period_start,
            period_end: previousRow.period_end,
          }
        : null,
    resultatrakning: computed.resultatrakning,
    balansrakning: computed.balansrakning,
    totals: computed.totals,
    eligibility: { confirmed, confirmed_at: inputs.eligibility_confirmed_at },
    notes: inputs.notes,
    signatories: inputs.signatories,
    blockers,
    warnings,
  }
}

// ─────────────────────────────────────────────────────────────────
// Doors: OperationOutcome for v1, MCP and the dashboard routes
// ─────────────────────────────────────────────────────────────────

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function failure(ctx: OperationContext, err: unknown): Failure {
  if (err instanceof ForenklatArsbokslutWrongFormError) {
    return { ok: false, code: 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM' }
  }
  if (err instanceof ForenklatArsbokslutPeriodNotFoundError) {
    return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' }
  }
  ctx.log.error('förenklat årsbokslut generation failed', err as Error)
  return { ok: false, code: 'REPORT_GENERATION_FAILED' }
}

export async function getForenklatArsbokslut(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<ForenklatArsbokslut>> {
  try {
    return { ok: true, data: await buildForenklatArsbokslut(ctx.supabase, ctx.companyId, periodId) }
  } catch (err) {
    return failure(ctx, err)
  }
}

/**
 * Save the year's eligibility confirmation, notes or signatories. The period
 * must be the company's and the form one that prepares a förenklat
 * årsbokslut. Not gated on the period lock: these are the document's own
 * inputs, written after the year is closed, never bokföring.
 */
export async function updateForenklatArsbokslutInputs(
  ctx: OperationContext,
  periodId: string,
  update: ForenklatArsbokslutInputsUpdate,
): Promise<OperationOutcome<ForenklatArsbokslutInputs>> {
  const [periodResult, settingsResult] = await Promise.all([
    ctx.supabase.from('fiscal_periods').select('id').eq('id', periodId).eq('company_id', ctx.companyId).maybeSingle(),
    ctx.supabase.from('company_settings').select('entity_type').eq('company_id', ctx.companyId).maybeSingle(),
  ])
  if (periodResult.error) return { ok: false, code: 'UNKNOWN_ERROR', error: periodResult.error }
  if (!periodResult.data) return { ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' }
  try {
    const form = await resolveCompanyEntityType(ctx.supabase, ctx.companyId, settingsResult.data?.entity_type)
    if (!preparesForenklatArsbokslut(form)) return { ok: false, code: 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM' }
    return {
      ok: true,
      data: await saveForenklatArsbokslutInputs(ctx.supabase, ctx.companyId, ctx.userId, periodId, update),
    }
  } catch (err) {
    return { ok: false, code: 'UNKNOWN_ERROR', error: err }
  }
}

/**
 * The PDF, refused with the reasons while any blocker holds: the title
 * "Förenklat årsbokslut" may only be used on a document that meets the law.
 */
export async function getForenklatArsbokslutPdfFile(
  ctx: OperationContext,
  periodId: string,
): Promise<OperationOutcome<ReportFile>> {
  const built = await getForenklatArsbokslut(ctx, periodId)
  if (!built.ok || built.dryRun) return built as Failure
  const report = built.data
  if (report.blockers.length > 0) {
    return {
      ok: false,
      code: 'FORENKLAT_ARSBOKSLUT_BLOCKED',
      details: { reason: report.blockers.map((b) => b.message).join(' '), blockers: report.blockers },
    }
  }
  try {
    // react-pdf and the template load here, not with every module that
    // reaches this one through the operations registry.
    const [{ renderToBuffer }, { ForenklatArsbokslutPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('./pdf'),
    ])
    const bytes = await renderToBuffer(ForenklatArsbokslutPDF({ report }))
    const periodEnd = report.fiscal_period.period_end.replace(/[^\w.-]/g, '_')
    return {
      ok: true,
      data: {
        filename: `forenklat-arsbokslut-${periodEnd}.pdf`,
        contentType: 'application/pdf',
        bytes: new Uint8Array(bytes),
      },
    }
  } catch (err) {
    return failure(ctx, err)
  }
}
