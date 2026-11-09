/**
 * What a filed declaration asks to have on the skattekonto, for a bank
 * payment in to it (prepare-skattekonto.ts): the momsdeklaration's ruta 49,
 * or the AGI's avdragen skatt plus arbetsgivaravgifter, with the day the
 * money must be there (62 kap. 3 § SFL) and whether the declaration is on
 * record as filed.
 *
 * Proposed, never invented:
 *   - VAT: ruta 49 as filed, every ruta in whole kronor and 49 their net
 *     (computeVatDeclaration, buildFiledAmounts): the figure the declaration
 *     is filed with, gnubok_vat_close_check payment.net_due and the
 *     momsverifikat on 2650. Due on the period's deadline: the deadline row
 *     when the company has one, else the day the generator would give it
 *     (vatPeriodDeadline).
 *   - AGI: the declaration's stored totals, what the tax payment file pays
 *     and Skatteverket draws. Due on the day the deadline configuration gives
 *     the month (getAgiPaymentDueDate: the 12th, 17th in January and
 *     August; the 12th, 17th in January, above the SEK 40M VAT taxable base),
 *     moved to the next banking day.
 *
 * Everything declared due on one day (due_date): the momsdeklaration and the
 * AGI(s) whose payment day is that day, each read by the resolver above and
 * summed, because the database holds one open skattekonto payment per
 * company and Skatteverket draws them from the same account on the same day.
 * A part that asks for nothing (a refund in ruta 49, zero, already paid, a
 * period not ended) is left out and reported, never netted against the rest.
 *
 * Nothing here nets the synced skattekonto saldo against the declaration:
 * the caller shows the saldo as information.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { roundOre } from '@/lib/money'
import { computeVatDeclaration } from '@/lib/reports/vat-declaration'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import { hasEnded } from '@/lib/dates/iso'
import { getAgiPaymentDueDate } from '@/lib/tax/deadline-config'
import { AGI_RECEIPT_STATUSES } from '@/lib/deadlines/agi-filed'
import { vatPeriodDeadline, type VatPeriodDeadline } from '@/lib/vat/filing-record-store'

/** The declaration a skattekonto payment pays. */
export type SkattekontoDeclarationSource =
  | {
      kind: 'vat_declaration'
      periodType: 'monthly' | 'quarterly' | 'yearly'
      /** Calendar year of the period; for yearly, the year the räkenskapsår ends. */
      year: number
      /** 1-12 monthly, 1-4 quarterly, 1 yearly. */
      period: number
      /** Yearly only: the räkenskapsår whose bounds the period takes. */
      fiscalPeriodId?: string | null
    }
  | {
      kind: 'agi'
      year: number
      /** The redovisningsperiod (the month the pay was paid out), 1-12. */
      month: number
    }

/**
 * What a skattekonto payment is named from: one declaration, or everything
 * declared due on one day (the momsdeklaration and the AGI paid as one
 * payment).
 */
export type SkattekontoPaymentSource = SkattekontoDeclarationSource | { kind: 'due_date'; dueDate: string }

/**
 * How a caller names what a skattekonto payment pays, the same on every door
 * (the dashboard route and payment-orders.prepare): next_charge (the default)
 * is what the synced skattekonto lacks for its next charge; vat_declaration
 * and agi name a declaration by its period; due_date names a day and pays
 * every declaration due on it.
 */
export const SKATTEKONTO_SOURCE_FIELDS = {
  source: z
    .enum(['next_charge', 'vat_declaration', 'agi', 'due_date'])
    .optional()
    .describe(
      'What the payment pays. next_charge (default): what the synced skattekonto lacks for its next charge. vat_declaration: ' +
        'the momsdeklaration of period_type/year/period (ruta 49, due on its deadline). agi: the arbetsgivardeklaration of ' +
        'year/month (avdragen skatt + arbetsgivaravgifter, due the 12th, 17th in January and August). due_date: everything ' +
        'declared due on due_date (the momsdeklaration and the AGI due that day) as one payment.',
    ),
  period_type: z.enum(['monthly', 'quarterly', 'yearly']).optional().describe('vat_declaration: the momsperiod length.'),
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .optional()
    .describe('vat_declaration and agi: calendar year of the period; for yearly VAT, the year the räkenskapsår ends.'),
  period: z.number().int().min(1).max(12).optional().describe('vat_declaration: 1-12 monthly, 1-4 quarterly, 1 yearly.'),
  month: z.number().int().min(1).max(12).optional().describe('agi: the redovisningsperiod, the month the pay went out (1-12).'),
  fiscal_period_id: z
    .string()
    .uuid()
    .optional()
    .describe('vat_declaration, yearly only: the räkenskapsår whose bounds the period takes, for a broken fiscal year.'),
  due_date: saneIsoDateSchema
    .optional()
    .describe('due_date: YYYY-MM-DD, the day the declarations must be paid by (e.g. 2026-11-12).'),
}

type SourceFields = {
  source?: 'next_charge' | 'vat_declaration' | 'agi' | 'due_date'
  period_type?: 'monthly' | 'quarterly' | 'yearly'
  year?: number
  period?: number
  month?: number
  fiscal_period_id?: string
  due_date?: string
}

/** The fields that name one declaration, and the day of the combined source. */
const DECLARATION_FIELDS = ['period_type', 'year', 'period', 'month', 'fiscal_period_id'] as const

/** Each source's required fields, and no declaration fields without one. */
export function refineSkattekontoSource(value: SourceFields, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
  if (value.source !== 'due_date' && value.due_date !== undefined) issue('due_date', 'due_date is for source due_date only.')
  if (value.source === 'due_date') {
    if (value.due_date === undefined) issue('due_date', 'due_date needs due_date.')
    for (const field of DECLARATION_FIELDS) {
      if (value[field] !== undefined) issue(field, 'due_date pays every declaration due that day: name no period.')
    }
    return
  }
  if (value.source === 'vat_declaration') {
    if (!value.period_type) issue('period_type', 'vat_declaration needs period_type.')
    if (value.year === undefined) issue('year', 'vat_declaration needs year.')
    if (value.period === undefined) issue('period', 'vat_declaration needs period.')
    if (value.period_type === 'quarterly' && value.period !== undefined && value.period > 4) {
      issue('period', 'For quarterly period_type, period must be 1-4.')
    }
    if (value.period_type === 'yearly' && value.period !== undefined && value.period !== 1) {
      issue('period', 'For yearly period_type, period must be 1.')
    }
    if (value.fiscal_period_id && value.period_type !== 'yearly') {
      issue('fiscal_period_id', 'fiscal_period_id is for a yearly period only.')
    }
    return
  }
  if (value.source === 'agi') {
    if (value.year === undefined) issue('year', 'agi needs year.')
    if (value.month === undefined) issue('month', 'agi needs month.')
    return
  }
  for (const field of DECLARATION_FIELDS) {
    if (value[field] !== undefined) issue(field, 'Name source vat_declaration or agi to pay a declaration.')
  }
}

/** The validated fields as a source; null for the next charge. */
export function toSkattekontoSource(value: SourceFields): SkattekontoPaymentSource | null {
  if (value.source === 'vat_declaration' && value.period_type && value.year !== undefined && value.period !== undefined) {
    return {
      kind: 'vat_declaration',
      periodType: value.period_type,
      year: value.year,
      period: value.period,
      fiscalPeriodId: value.fiscal_period_id ?? null,
    }
  }
  if (value.source === 'agi' && value.year !== undefined && value.month !== undefined) {
    return { kind: 'agi', year: value.year, month: value.month }
  }
  if (value.source === 'due_date' && value.due_date !== undefined) {
    return { kind: 'due_date', dueDate: value.due_date }
  }
  return null
}

/**
 * Why a declaration asks for no payment: it declares money back (refund),
 * nothing (zero), its tax is already marked paid (already_paid, AGI), or its
 * period has not ended so there is no declaration yet (period_not_ended, VAT).
 */
export type SkattekontoSourceNothingDue = 'refund' | 'zero' | 'already_paid' | 'period_not_ended'

/** What the declaration asks for, as the preview and the answer show it. */
export interface SkattekontoSourceDue {
  kind: 'vat_declaration' | 'agi'
  /** The deadline's period label: YYYY-MM, YYYY-QN, or the räkenskapsår for helårsmoms. */
  tax_period: string
  /** Signed: ruta 49 (negative = to get back) or the AGI's skatt + avgifter. */
  declared: number
  /** YYYY-MM-DD the money must be on the skattekonto by; null when the day cannot be placed. */
  due_date: string | null
  /** The declaration is on record as filed (its deadline completed, or the AGI submitted to Skatteverket). */
  filed: boolean
  /** AGI only: when the month's tax was marked paid (by hand, or by the skattekonto sync). */
  paid_at: string | null
  /** What to pay in: declared when it asks for a payment, else null with nothing_due saying why. */
  payable: number | null
  nothing_due: SkattekontoSourceNothingDue | null
  /** YYYY-MM-DD: a bank payment to the skattekonto created on or after it may already pay this declaration. */
  paid_from: string
}

export type SkattekontoSourceResolution =
  | { ok: true; due: SkattekontoSourceDue }
  | { ok: false; code: 'SKATTEKONTO_PAYMENT_AGI_NOT_FOUND' | 'VAT_REPORT_GENERATION_FAILED'; details?: Record<string, unknown> }

/** The AGI statuses that mean the declaration reached Skatteverket. */
const AGI_FILED_STATUSES = new Set(AGI_RECEIPT_STATUSES)

function nothingDueFor(declared: number): SkattekontoSourceNothingDue | null {
  if (declared < 0) return 'refund'
  if (declared === 0) return 'zero'
  return null
}

async function resolveVatDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  source: Extract<SkattekontoDeclarationSource, { kind: 'vat_declaration' }>,
  today: string,
  /** The period's deadline when the caller has read it already (the due-date search). */
  placed?: VatPeriodDeadline,
): Promise<SkattekontoSourceResolution> {
  let computed: Awaited<ReturnType<typeof computeVatDeclaration>>
  try {
    computed = await computeVatDeclaration(
      supabase,
      companyId,
      source.periodType,
      source.year,
      source.period,
      source.fiscalPeriodId ? { fiscalPeriodId: source.fiscalPeriodId } : {},
    )
  } catch (err) {
    return {
      ok: false,
      code: 'VAT_REPORT_GENERATION_FAILED',
      details: { reason: err instanceof Error ? err.message : 'unknown' },
    }
  }
  const deadline =
    placed ??
    (await vatPeriodDeadline(supabase, companyId, {
      periodType: source.periodType,
      year: source.year,
      period: source.period,
    }))
  const declared = buildFiledAmounts(computed.declaration.rutor).net
  const periodEnd = computed.declaration.period.end
  // A period that has not ended has no declaration yet: what the books show
  // so far is not what will be filed.
  const nothingDue = !hasEnded(periodEnd, today) ? 'period_not_ended' : nothingDueFor(declared)
  return {
    ok: true,
    due: {
      kind: 'vat_declaration',
      tax_period: deadline.tax_period,
      declared,
      due_date: deadline.due_date,
      filed: deadline.filed,
      paid_at: null,
      payable: nothingDue ? null : declared,
      nothing_due: nothingDue,
      paid_from: periodEnd,
    },
  }
}

async function resolveAgi(
  supabase: SupabaseClient,
  companyId: string,
  source: Extract<SkattekontoDeclarationSource, { kind: 'agi' }>,
): Promise<SkattekontoSourceResolution> {
  const taxPeriod = `${source.year}-${String(source.month).padStart(2, '0')}`
  const [agiRes, settingsRes, deadlineRes] = await Promise.all([
    supabase
      .from('agi_declarations')
      .select('status, total_tax, total_avgifter, tax_paid_at')
      .eq('company_id', companyId)
      .eq('period_year', source.year)
      .eq('period_month', source.month)
      .maybeSingle(),
    supabase
      .from('company_settings')
      .select('vat_registered, vat_taxable_base_over_40m')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('deadlines')
      .select('is_completed')
      .eq('company_id', companyId)
      .eq('tax_deadline_type', 'arbetsgivardeklaration')
      .eq('tax_period', taxPeriod)
      .is('dismissed_at', null)
      .limit(1),
  ])
  if (agiRes.error) throw agiRes.error
  if (settingsRes.error) throw settingsRes.error
  if (deadlineRes.error) throw deadlineRes.error
  const agi = agiRes.data as {
    status: string
    total_tax: number | string
    total_avgifter: number | string
    tax_paid_at: string | null
  } | null
  if (!agi) return { ok: false, code: 'SKATTEKONTO_PAYMENT_AGI_NOT_FOUND', details: { tax_period: taxPeriod } }

  const settings = settingsRes.data as { vat_registered: boolean | null; vat_taxable_base_over_40m: boolean | null } | null
  const dueDate = getAgiPaymentDueDate(source.year, source.month, {
    vat_registered: settings?.vat_registered === true,
    vat_taxable_base_over_40m: settings?.vat_taxable_base_over_40m === true,
  })
  const deadlineRows = (deadlineRes.data ?? []) as Array<{ is_completed: boolean | null }>
  const filed = AGI_FILED_STATUSES.has(agi.status) || deadlineRows.some((row) => row.is_completed === true)

  // The stored totals are whole kronor since the whole-krona change, öre on
  // legacy rows: the sum to the öre is what the tax payment file pays either way.
  const declared = roundOre(Number(agi.total_tax) + Number(agi.total_avgifter))
  const nothingDue: SkattekontoSourceNothingDue | null = agi.tax_paid_at ? 'already_paid' : nothingDueFor(declared)
  return {
    ok: true,
    due: {
      kind: 'agi',
      tax_period: taxPeriod,
      declared,
      due_date: dueDate,
      filed,
      paid_at: agi.tax_paid_at,
      payable: nothingDue ? null : declared,
      nothing_due: nothingDue,
      // Pay goes out, and the AGI is generated, inside the month itself.
      paid_from: `${taxPeriod}-01`,
    },
  }
}

/** What the declaration asks to have on the skattekonto, and by when. */
export async function resolveSkattekontoSource(
  supabase: SupabaseClient,
  companyId: string,
  source: SkattekontoDeclarationSource,
  today: string,
): Promise<SkattekontoSourceResolution> {
  return source.kind === 'vat_declaration'
    ? resolveVatDeclaration(supabase, companyId, source, today)
    : resolveAgi(supabase, companyId, source)
}

/** One declaration in a payment of everything due on a day: what it adds to the payment. */
export interface SkattekontoDueDateComponent {
  source: 'vat_declaration' | 'agi'
  /** The declaration's period label (tax_period). */
  period: string
  amount: number
}

/** A declaration due on the day that asks for no payment: shown, never netted against the rest. */
export interface SkattekontoDueDateExcluded {
  source: 'vat_declaration' | 'agi'
  period: string
  /** Signed, as declared: a refund is negative. */
  declared: number
  reason: SkattekontoSourceNothingDue
}

/** Everything declared due on one day: the parts paid, their sum, and the parts left out. */
export interface SkattekontoDueDateDue {
  due_date: string
  /** The sum of the components, to the öre. */
  total: number
  components: SkattekontoDueDateComponent[]
  excluded: SkattekontoDueDateExcluded[]
}

export type SkattekontoDueDateResolution =
  | {
      ok: true
      combined: SkattekontoDueDateDue
      /** Every declaration due on the day as its own source resolves it, payable or not, moms first. */
      parts: SkattekontoSourceDue[]
    }
  | { ok: false; code: 'VAT_REPORT_GENERATION_FAILED'; details?: Record<string, unknown> }

/** The month `back` months before the month of an ISO day. */
function monthBefore(iso: string, back: number): { year: number; month: number } {
  const index = Number(iso.slice(0, 4)) * 12 + (Number(iso.slice(5, 7)) - 1) - back
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

/**
 * The moms periods whose payment could fall on `dueDate`, for the cadence the
 * company reports moms in; each is kept only when its own deadline says so.
 * A monthly period is due one or two months after it (above or below the SEK
 * 40M base), a quarter within three, a räkenskapsår within the next calendar
 * year.
 */
function vatCandidates(
  dueDate: string,
  momsPeriod: 'monthly' | 'quarterly' | 'yearly' | null,
): Array<Extract<SkattekontoDeclarationSource, { kind: 'vat_declaration' }>> {
  const year = Number(dueDate.slice(0, 4))
  if (momsPeriod === 'monthly') {
    return [1, 2].map((back) => {
      const m = monthBefore(dueDate, back)
      return { kind: 'vat_declaration', periodType: 'monthly', year: m.year, period: m.month }
    })
  }
  if (momsPeriod === 'quarterly') {
    return [1, 2, 3]
      .map((back) => monthBefore(dueDate, back))
      .filter((m) => m.month % 3 === 0)
      .map((m) => ({ kind: 'vat_declaration', periodType: 'quarterly', year: m.year, period: m.month / 3 }))
  }
  if (momsPeriod === 'yearly') {
    return [year - 1, year].map((y) => ({ kind: 'vat_declaration', periodType: 'yearly', year: y, period: 1 }))
  }
  return []
}

function sameDeclaration(a: SkattekontoDeclarationSource, b: SkattekontoDeclarationSource): boolean {
  if (a.kind === 'agi' && b.kind === 'agi') return a.year === b.year && a.month === b.month
  if (a.kind === 'vat_declaration' && b.kind === 'vat_declaration') {
    return a.periodType === b.periodType && a.year === b.year && a.period === b.period
  }
  return false
}

/**
 * Everything the company has declared due on `dueDate`: the momsdeklaration
 * of its moms cadence and the AGI(s) whose payment day is that day, each
 * read by its own resolver (amount, due date and filing state are theirs),
 * summed into one payment. A part that asks for nothing is excluded with its
 * reason, never netted. `known` is a declaration the caller resolved
 * already: it is taken as is instead of being read again.
 */
export async function resolveSkattekontoDueDate(
  supabase: SupabaseClient,
  companyId: string,
  dueDate: string,
  today: string,
  known?: { source: SkattekontoDeclarationSource; due: SkattekontoSourceDue },
): Promise<SkattekontoDueDateResolution> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('vat_registered, moms_period')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const settings = data as { vat_registered: boolean | null; moms_period: 'monthly' | 'quarterly' | 'yearly' | null } | null

  const parts: SkattekontoSourceDue[] = []
  // The caller's own declaration is not read again: it joins below as resolved.
  const isKnown = (source: SkattekontoDeclarationSource) => (known ? sameDeclaration(known.source, source) : false)

  // Moms: a cheap look at each candidate's deadline first; only the period
  // due that day is computed from the books.
  const vatSources = settings?.vat_registered === true ? vatCandidates(dueDate, settings.moms_period) : []
  for (const source of vatSources) {
    if (isKnown(source)) continue
    const placed = await vatPeriodDeadline(supabase, companyId, {
      periodType: source.periodType,
      year: source.year,
      period: source.period,
    })
    if (placed.due_date !== dueDate) continue
    const resolved = await resolveVatDeclaration(supabase, companyId, source, today, placed)
    if (!resolved.ok) return { ok: false, code: 'VAT_REPORT_GENERATION_FAILED', details: resolved.details }
    parts.push(resolved.due)
  }

  // An AGI is paid the month after its redovisningsperiod; two months are
  // asked so the resolver's due date, not this list, decides.
  const agiSources: Array<Extract<SkattekontoDeclarationSource, { kind: 'agi' }>> = [1, 2].map((back) => ({
    kind: 'agi',
    ...monthBefore(dueDate, back),
  }))
  for (const source of agiSources) {
    if (isKnown(source)) continue
    // A month without an AGI has nothing declared: no part.
    const resolved = await resolveAgi(supabase, companyId, source)
    if (resolved.ok && resolved.due.due_date === dueDate) parts.push(resolved.due)
  }
  // The caller's declaration counts when due that day, also outside the
  // cadence's candidates (a period of another cadence, a company not marked
  // VAT registered).
  if (known && known.due.due_date === dueDate) parts.push(known.due)
  parts.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'vat_declaration' ? -1 : 1))

  const components: SkattekontoDueDateComponent[] = []
  const excluded: SkattekontoDueDateExcluded[] = []
  for (const part of parts) {
    if (part.payable !== null) components.push({ source: part.kind, period: part.tax_period, amount: part.payable })
    else excluded.push({ source: part.kind, period: part.tax_period, declared: part.declared, reason: part.nothing_due ?? 'zero' })
  }
  const total = roundOre(components.reduce((sum, c) => sum + c.amount, 0))
  return { ok: true, combined: { due_date: dueDate, total, components, excluded }, parts }
}
