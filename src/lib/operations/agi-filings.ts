/**
 * Recording that an arbetsgivardeklaration (AGI) was filed outside Accounted
 * (agent feedback seq 892914): a company that migrates mid-year files AGI from
 * its old system or on skatteverket.se, and the period's AGI deadline kept
 * asking for it. The VAT counterpart is vat-filings.mark.
 *
 * What it does: completes the period's system-generated AGI deadline
 * (tax_deadline_type arbetsgivardeklaration, tax_period YYYY-MM) with status
 * submitted and the filing date, the state the deadline engine and the
 * dashboard read. It sends nothing to Skatteverket and touches no AGI
 * declaration, salary run or verifikat. A deadline Skatteverket confirmed
 * through the connection (status confirmed) is left as it is.
 *
 * MCP only: the dashboard completes a deadline by id
 * (POST /api/deadlines/:id/complete), which also undoes the mark.
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { defineOperation } from './types'

const AGI_DEADLINE_TYPE = 'arbetsgivardeklaration'
const META = { request_id: 'req_…', api_version: '2026-05-12' }

interface AgiDeadlineRow {
  id: string
  tax_period: string
  due_date: string | null
  is_completed: boolean
  completed_at: string | null
  status: string | null
}

/** The deadline generator's AGI period key (lib/tax/deadline-config.ts). */
function agiTaxPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

/** A date stored as completed_at: midday UTC keeps it on the same Swedish calendar day. */
function filedOnToCompletedAt(filedOn: string): string {
  return `${filedOn}T12:00:00.000Z`
}

export const agiFilingsMark = defineOperation({
  id: 'agi-filings.mark',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'low',
  // The dashboard un-ticks the deadline (POST /api/deadlines/:id/complete).
  reversible: true,
  docs: {
    summary: 'Record that an AGI period was filed outside Accounted.',
    description:
      "Completes the month's arbetsgivardeklaration deadline with status submitted and the filing date, so it stops asking to be filed. Nothing is sent to Skatteverket, and no AGI declaration, salary run or verifikat changes. A deadline Skatteverket confirmed through the connection is left unchanged.",
    useWhen:
      'The AGI for a month was filed on skatteverket.se, by an ombud or from the previous system, and its deadline in Accounted still shows it as due.',
    doNotUseFor: 'Filing the AGI itself: that is the BankID-signed flow (gnubok_agi_submit).',
    pitfalls: [
      'month is the redovisningsperiod (the salary month), not the month the deadline falls in: the AGI for January is due in February.',
      'filed_on cannot be in the future (AGI_FILING_DATE_IN_FUTURE).',
      'AGI_DEADLINE_NOT_FOUND when the company has no AGI deadline for the month: the employer registration in Inställningar decides which months get one.',
    ],
    example: {
      request: { year: 2026, month: 8, filed_on: '2026-09-10' },
      response: {
        data: { deadline_id: '11111111-1111-4111-8111-111111111111', tax_period: '2026-08', filed_on: '2026-09-10', status: 'submitted', changed: true },
        meta: META,
      },
    },
  },
  input: z.object({
    year: z.number().int().min(2000).max(2100).describe('Calendar year of the redovisningsperiod.'),
    month: z.number().int().min(1).max(12).describe('The redovisningsperiod (salary month), 1-12.'),
    filed_on: saneIsoDateSchema.describe('Swedish calendar date the AGI was filed (YYYY-MM-DD), not in the future.'),
  }),
  output: z.object({
    deadline_id: z.string().uuid(),
    tax_period: z.string().describe('YYYY-MM.'),
    filed_on: z.string(),
    status: z.enum(['submitted', 'confirmed']),
    changed: z.boolean().describe('False when Skatteverket already confirmed the period and nothing was changed.'),
  }),
  errorCodes: ['AGI_DEADLINE_NOT_FOUND', 'AGI_FILING_DATE_IN_FUTURE', 'AGI_FILING_MARK_FAILED'],
  mcp: {
    name: 'gnubok_mark_agi_period_filed',
    title: 'Mark AGI Period Filed',
    description:
      "Stage recording that a month's arbetsgivardeklaration (AGI) was filed outside Accounted, e.g. from the previous system. Completes that month's AGI deadline with the filing date. Sends nothing to Skatteverket.",
    keywords: ['arbetsgivardeklaration', 'agi', 'inlämnad', 'markera som inlämnad', 'agi inlämnad', 'deadline'],
    stage: {
      pendingType: 'mark_agi_period_filed',
      title: (input) =>
        `Markera arbetsgivardeklaration ${agiTaxPeriod(Number(input.year), Number(input.month))} som inlämnad`,
    },
  },
  run: async (ctx, { year, month, filed_on }, { dryRun }) => {
    if (filed_on > todayIsoStockholm()) return { ok: false, code: 'AGI_FILING_DATE_IN_FUTURE' }
    const taxPeriod = agiTaxPeriod(year, month)

    const { data, error } = await ctx.supabase
      .from('deadlines')
      .select('id, tax_period, due_date, is_completed, completed_at, status')
      .eq('company_id', ctx.companyId)
      .eq('tax_deadline_type', AGI_DEADLINE_TYPE)
      .eq('tax_period', taxPeriod)
      .order('due_date', { ascending: true })
      .limit(1)
    if (error) return { ok: false, code: 'AGI_FILING_MARK_FAILED', messageSv: getErrorMessage(error) }
    const existing = ((data ?? []) as AgiDeadlineRow[])[0]
    if (!existing) return { ok: false, code: 'AGI_DEADLINE_NOT_FOUND', details: { tax_period: taxPeriod } }

    const confirmed = existing.status === 'confirmed'
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          deadline_id: existing.id,
          tax_period: taxPeriod,
          due_date: existing.due_date,
          filed_on,
          current: { is_completed: existing.is_completed, status: existing.status },
          effect: confirmed ? 'unchanged_confirmed_by_skatteverket' : 'mark_submitted',
        },
      }
    }
    if (confirmed) {
      return {
        ok: true,
        data: { deadline_id: existing.id, tax_period: taxPeriod, filed_on, status: 'confirmed' as const, changed: false },
      }
    }

    // Guarded on status: a kvittens that confirmed the period in between wins.
    const { data: updated, error: updateError } = await ctx.supabase
      .from('deadlines')
      .update({
        is_completed: true,
        completed_at: filedOnToCompletedAt(filed_on),
        status: 'submitted',
        status_changed_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .eq('company_id', ctx.companyId)
      .or('status.is.null,status.neq.confirmed')
      .select('id')
      .maybeSingle()
    if (updateError) {
      return { ok: false, code: 'AGI_FILING_MARK_FAILED', messageSv: getErrorMessage(updateError) }
    }
    return {
      ok: true,
      data: {
        deadline_id: existing.id,
        tax_period: taxPeriod,
        filed_on,
        status: updated ? ('submitted' as const) : ('confirmed' as const),
        changed: Boolean(updated),
      },
    }
  },
})
