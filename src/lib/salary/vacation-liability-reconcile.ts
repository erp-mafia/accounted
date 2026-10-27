/**
 * "Stäm av semesterlöneskuld per datum" and the switch of booking method:
 * the remeasurement (vacation-liability-remeasure.ts) on a date without a
 * salary run. The operation salary.vacation-liability.reconcile (v1), the
 * dashboard route and the method switch all call reconcileVacationLiability,
 * so they refuse and book alike.
 *
 * Refusals before anything is written: a date still ahead (the runs that
 * would move the liability by then are not booked yet), no fiscal year
 * covering the date, and a closed or locked period or a date on or before
 * the company lock date (PERIOD_LOCKED; the database triggers stay the
 * backstop). Nothing to book (every difference within 1 krona) is no
 * refusal: the answer says nothing was adjusted, so a repeat is harmless.
 */

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type { Logger } from '@/lib/logger'
import type { OperationOutcome, OperationWarning } from '@/lib/operations/types'
import {
  frozenRemeasureReport,
  planVacationLiabilityRemeasure,
  vacationLiabilityRemeasureEvent,
} from './vacation-liability-remeasure'
import type { RemeasurePlan } from './vacation-liability-plan'
import { vacationLiabilityMethodFrom, type VacationLiabilityMethod } from './vacation-liability-method'

export interface ReconcileContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}

export interface VacationLiabilityReconcileResult {
  as_of: string
  /** False when every difference stayed within 1 krona: nothing was booked. */
  adjusted: boolean
  journal_entry_id: string | null
  voucher_series: string | null
  voucher_number: number | null
  booked_2920: number
  booked_2940: number
  computed_liability: number
  computed_avgifter: number
  difference_2920: number
  difference_2940: number
}

/** The verifikat text of a remeasurement on a date. */
export function remeasureDescription(asOf: string): string {
  return `Semesterlöneskuld per ${asOf}`
}

/** The dry run's preview: what would be booked, deterministic for unchanged books. */
export function reconcilePreview(plan: RemeasurePlan): Record<string, unknown> {
  return {
    as_of: plan.as_of_date,
    entry_date: plan.as_of_date,
    description: remeasureDescription(plan.as_of_date),
    would_post: plan.lines.length > 0,
    booked_2920: plan.booked_2920,
    booked_2940: plan.booked_2940,
    computed_liability: plan.computed_liability,
    computed_avgifter: plan.computed_avgifter,
    difference_2920: plan.difference_2920,
    difference_2940: plan.difference_2940,
    lines: plan.lines.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      line_description: line.line_description ?? null,
      ...(line.dimensions ? { dimensions: line.dimensions } : {}),
    })),
    employees: plan.rows.map((row) => ({
      employee_id: row.employee_id,
      employee_name: row.employee_name,
      liability_days: row.days?.total_days ?? 0,
      day_value_sek: row.day_value_sek,
      computed_liability_sek: row.computed_liability_sek,
      computed_avgifter_sek: row.computed_avgifter_sek,
      booked_liability_sek: row.booked_liability_sek,
      booked_avgifter_sek: row.booked_avgifter_sek,
      adjustment_2920: row.adjustment_2920,
      adjustment_2940: row.adjustment_2940,
    })),
  }
}

export async function reconcileVacationLiability(
  ctx: ReconcileContext,
  input: { as_of: string; kind?: 'standalone' | 'method_switch' },
  options: { dryRun: boolean },
): Promise<OperationOutcome<VacationLiabilityReconcileResult>> {
  const asOf = input.as_of
  const today = todayIsoStockholm()
  if (asOf > today) {
    return { ok: false, code: 'VACATION_LIABILITY_DATE_AHEAD', details: { as_of: asOf, today } }
  }

  let planned
  try {
    planned = await planVacationLiabilityRemeasure(ctx.supabase, ctx.companyId, asOf)
  } catch (err) {
    ctx.log.error('vacation liability remeasurement failed', err as Error, { asOf })
    return { ok: false, code: 'VACATION_LIABILITY_RECONCILE_FAILED' }
  }
  if (!planned.ok) {
    if (planned.code === 'VALIDATION_ERROR') {
      return { ok: false, code: 'VACATION_LIABILITY_NO_FISCAL_PERIOD', details: { as_of: asOf } }
    }
    ctx.log.error('vacation liability remeasurement failed', new Error(planned.code), { asOf, details: planned.details })
    return { ok: false, code: 'VACATION_LIABILITY_RECONCILE_FAILED' }
  }
  const plan = planned.data

  if (plan.lines.length > 0) {
    const lock = await checkPeriodLock(ctx.supabase, ctx.companyId, asOf)
    if (lock.locked) {
      return {
        ok: false,
        code: 'PERIOD_LOCKED',
        details: { reason: lock.reason, fiscal_period_id: lock.fiscal_period_id, entry_date: asOf },
      }
    }
  }

  if (options.dryRun) return { ok: true, dryRun: true, preview: reconcilePreview(plan) }

  const result: VacationLiabilityReconcileResult = {
    as_of: asOf,
    adjusted: false,
    journal_entry_id: null,
    voucher_series: null,
    voucher_number: null,
    booked_2920: plan.booked_2920,
    booked_2940: plan.booked_2940,
    computed_liability: plan.computed_liability,
    computed_avgifter: plan.computed_avgifter,
    difference_2920: plan.difference_2920,
    difference_2940: plan.difference_2940,
  }
  if (plan.lines.length === 0) return { ok: true, data: result }

  const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId, asOf)
  if (!fiscalPeriodId) return { ok: false, code: 'VACATION_LIABILITY_NO_FISCAL_PERIOD', details: { as_of: asOf } }

  // The remeasurement's id is the verifikat's source_id, so the row and the
  // voucher name each other; the row is written once the voucher is posted.
  const remeasurementId = randomUUID()
  let entry
  try {
    entry = await postingPort.postJournalEntry({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      event: () => vacationLiabilityRemeasureEvent(plan, remeasurementId, linkBasisColumns('user_created')),
      input: {
        fiscal_period_id: fiscalPeriodId,
        entry_date: asOf,
        description: remeasureDescription(asOf),
        source_type: 'salary_payment',
        source_id: remeasurementId,
        lines: plan.lines,
      },
    })
  } catch (err) {
    // The engine's own refusal (a lock set meanwhile, an inactive account)
    // reaches the door verbatim.
    return { ok: false, code: 'VACATION_LIABILITY_RECONCILE_FAILED', error: err }
  }

  const warnings: OperationWarning[] = []
  const { error: rowError } = await ctx.supabase.from('vacation_liability_remeasurements').insert({
    id: remeasurementId,
    company_id: ctx.companyId,
    as_of_date: asOf,
    kind: input.kind ?? 'standalone',
    salary_run_id: null,
    journal_entry_id: entry.id,
    report: frozenRemeasureReport(plan),
  })
  if (rowError) {
    // The verifikat is posted and stands; only its stored calculation is
    // missing. The next remeasurement still lands on the computed total.
    ctx.log.error('vacation liability remeasurement posted but its calculation was not stored', new Error(rowError.message), {
      journalEntryId: entry.id,
    })
    warnings.push({
      code: 'VACATION_LIABILITY_REPORT_NOT_STORED',
      message_sv: 'Verifikatet är bokfört, men beräkningen bakom det kunde inte sparas. Ta ut Semesterskuld-rapporten per samma datum som underlag.',
      message_en: 'The voucher is posted, but the calculation behind it could not be stored. Export the Semesterskuld report as of the same date as its underlag.',
    })
  }

  const voucherNumber = (entry as { voucher_number?: number | null }).voucher_number ?? null
  return {
    ok: true,
    data: {
      ...result,
      adjusted: true,
      journal_entry_id: entry.id,
      voucher_series: (entry as { voucher_series?: string | null }).voucher_series ?? null,
      voucher_number: typeof voucherNumber === 'number' ? voucherNumber : null,
    },
    ...(warnings.length ? { warnings } : {}),
  }
}

export interface VacationLiabilityMethodResult {
  method: VacationLiabilityMethod
  previous_method: VacationLiabilityMethod
  /** The catch-up remeasurement, when switching to 'remeasure' booked one. */
  catch_up: VacationLiabilityReconcileResult | null
}

/** The company's current booking method. */
export async function readVacationLiabilityMethod(
  supabase: SupabaseClient,
  companyId: string,
): Promise<VacationLiabilityMethod> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('salary_vacation_liability_method')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return vacationLiabilityMethodFrom((data as { salary_vacation_liability_method?: unknown } | null)?.salary_vacation_liability_method)
}

/**
 * Change the booking method. To 'remeasure': the catch-up remeasurement as
 * of today is booked first (a dry run previews it, refusals as for
 * reconcileVacationLiability), then the method changes, so the books and the
 * setting never disagree for longer than one failed write. Runs calculated
 * from then on book the difference at every run; a run calculated before
 * keeps the accrual it was calculated with until it is recalculated. To
 * 'accrual': only the setting changes; the next semesterårsavslut trues the
 * accruals up as before.
 */
export async function setVacationLiabilityMethod(
  ctx: ReconcileContext,
  input: { method: VacationLiabilityMethod },
  options: { dryRun: boolean },
): Promise<OperationOutcome<VacationLiabilityMethodResult>> {
  let current: VacationLiabilityMethod
  try {
    current = await readVacationLiabilityMethod(ctx.supabase, ctx.companyId)
  } catch (err) {
    return { ok: false, code: 'VACATION_LIABILITY_RECONCILE_FAILED', error: err }
  }
  const asOf = todayIsoStockholm()

  let catchUp: VacationLiabilityReconcileResult | null = null
  if (input.method === 'remeasure' && current !== 'remeasure') {
    const reconciled = await reconcileVacationLiability(ctx, { as_of: asOf, kind: 'method_switch' }, options)
    if (!reconciled.ok) return reconciled
    if (reconciled.dryRun) {
      return { ok: true, dryRun: true, preview: { method: input.method, previous_method: current, catch_up: reconciled.preview } }
    }
    catchUp = reconciled.data
  } else if (options.dryRun) {
    return { ok: true, dryRun: true, preview: { method: input.method, previous_method: current, catch_up: null } }
  }

  if (input.method !== current) {
    const { error } = await ctx.supabase
      .from('company_settings')
      .update({ salary_vacation_liability_method: input.method })
      .eq('company_id', ctx.companyId)
    if (error) return { ok: false, code: 'VACATION_LIABILITY_RECONCILE_FAILED', error }
  }
  return { ok: true, data: { method: input.method, previous_method: current, catch_up: catchUp } }
}
