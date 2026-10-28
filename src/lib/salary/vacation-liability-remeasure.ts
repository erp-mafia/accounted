/**
 * Remeasurement of the semesterlöneskuld: book the difference between the
 * computed liability (vacation-liability-valuation.ts) and what 2920/2940
 * hold, so the balance sheet carries the day-valued liability on the date
 * instead of an accrual that is trued up once a year.
 *
 * Three producers, one posting model:
 *   - a salary run of a company on salary_vacation_liability_method
 *     'remeasure' (snapshotted into the run's calculation_params at
 *     :calculate): its vacation verifikat is the remeasurement as of the
 *     run's payment date, after the run (createSalaryRunEntries);
 *   - "stäm av per datum" (kind standalone): the same voucher on a date
 *     without a run, typically a month end;
 *   - the switch to 'remeasure' (kind method_switch): the first, catch-up
 *     remeasurement, previewed before the method changes.
 *
 * As-of date of a run's remeasurement: the payment date, the date every
 * verifikat of the run carries. The valuation counts the run being booked as
 * booked (its leave and its rörliga lönedelar), every booked run paid by then
 * or whose leave ended by then, and the days earned up to and including the
 * payment date.
 *
 * Lines (one verifikat): per employee, the difference between the computed
 * liability and the employee's share of what is booked (the Semesterskuld
 * report's booked specification, generateBookedVacationSpec). What 2920
 * holds beyond the sum of those shares (a manual entry, a close's adjustment
 * dated before a remeasurement) is spread over the employees pro rata to
 * their computed liability, so the voucher always brings 2920 to the computed
 * total. The cost side books per employee category (7090 arbetare, 7290
 * everyone else) and dimensions bag, debit when the liability grows and
 * credit when it shrinks; 2920 is one line. 2940 against 7519 likewise, at
 * each employee's age-tier rate. A side whose every amount stays within
 * 1 krona is not booked (öre noise is no verifikat; the next remeasurement
 * picks it up).
 *
 * The frozen calculation is stored per remeasurement
 * (vacation_liability_remeasurements): it is the verifikat's underlag and the
 * Semesterskuld report's next anchor.
 *
 * Retry: a run's booking that stops after its vacation verifikat posted is
 * resumed by createSalaryRunEntries, which adopts a posted voucher only when
 * it is exactly the one it would post now. The remeasurement therefore reads
 * 2920/2940 WITHOUT the run's own posted vouchers, and the specification
 * leaves out the run's own remeasurement row (its run is not booked yet), so
 * a retry on unchanged books computes the same lines.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { generateBookedVacationSpec } from '@/lib/reports/vacation-liability'
import { categoryForTemplateGroup } from '@/lib/posting/categories'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { bookedVacationBalances } from './semesterberedning'
import { SALARY_ACCOUNTS } from './account-mapping'
import { computeVacationLiability } from './vacation-liability-valuation'
import { buildRemeasurePlan, type RemeasurePlan } from './vacation-liability-plan'

/**
 * 2920/2940 as booked on `asOfDate`, without the posted vouchers of
 * `excludeRunId` (a run whose booking is being resumed: its own vacation
 * verifikat must not count as the starting point it is computed from).
 */
async function bookedBalancesWithoutRun(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
  excludeRunId: string | undefined,
): Promise<{ ok: true; data: { booked2920: number; booked2940: number } } | { ok: false; code: string; details?: Record<string, unknown> }> {
  const booked = await bookedVacationBalances(supabase, companyId, asOfDate)
  if (!booked.ok || !excludeRunId) return booked
  const { data, error } = await supabase
    .from('journal_entries')
    .select('entry_date, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
    .eq('company_id', companyId)
    .eq('source_type', 'salary_payment')
    .eq('source_id', excludeRunId)
    .eq('status', 'posted')
  if (error) return { ok: false, code: 'INTERNAL_ERROR', details: { message: error.message } }
  let own2920 = 0
  let own2940 = 0
  for (const entry of (data ?? []) as Array<{
    entry_date: string
    lines?: Array<{ account_number: string; debit_amount: number | string | null; credit_amount: number | string | null }> | null
  }>) {
    if (entry.entry_date > asOfDate) continue
    for (const line of entry.lines ?? []) {
      const credit = Number(line.credit_amount || 0) - Number(line.debit_amount || 0)
      if (line.account_number === SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY) own2920 += credit
      if (line.account_number === SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY) own2940 += credit
    }
  }
  return {
    ok: true,
    data: {
      booked2920: roundOre(booked.data.booked2920 - own2920),
      booked2940: roundOre(booked.data.booked2940 - own2940),
    },
  }
}

export type RemeasurePlanResult =
  | { ok: true; data: RemeasurePlan }
  | { ok: false; code: string; details?: Record<string, unknown> }

/**
 * The remeasurement as of `asOfDate`. `inFlightRunId` is the run being booked
 * (its days and rörliga lönedelar count as booked; its own posted vouchers
 * do not count as booked). Throws only on an unexpected read failure.
 */
export async function planVacationLiabilityRemeasure(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
  options: { inFlightRunId?: string } = {},
): Promise<RemeasurePlanResult> {
  const booked = await bookedBalancesWithoutRun(supabase, companyId, asOfDate, options.inFlightRunId)
  if (!booked.ok) return booked
  const spec = await generateBookedVacationSpec(supabase, companyId, asOfDate)
  const valuation = await computeVacationLiability(supabase, companyId, asOfDate, options)
  return { ok: true, data: buildRemeasurePlan(valuation, spec.rows, booked.data) }
}

/** What the vacation_liability_remeasurements row freezes: the plan without its lines. */
export function frozenRemeasureReport(plan: RemeasurePlan): Record<string, unknown> {
  const { lines: _lines, ...report } = plan
  void _lines
  return report as unknown as Record<string, unknown>
}

/**
 * Store a run's remeasurement before its vouchers post, so the underlag
 * exists whenever the verifikat does. One row per run: a resumed booking
 * rewrites its own row. The report anchors on it only once the run is
 * booked.
 */
export async function upsertRunRemeasurement(
  supabase: SupabaseClient,
  args: { companyId: string; salaryRunId: string; plan: RemeasurePlan },
): Promise<void> {
  const { error } = await supabase.from('vacation_liability_remeasurements').upsert(
    {
      company_id: args.companyId,
      as_of_date: args.plan.as_of_date,
      kind: 'salary_run',
      salary_run_id: args.salaryRunId,
      journal_entry_id: null,
      report: frozenRemeasureReport(args.plan),
    },
    { onConflict: 'salary_run_id' },
  )
  if (error) throw new Error(`Kunde inte spara beräkningen av semesterlöneskulden: ${error.message}`)
}

/** Link a run's remeasurement to its posted verifikat. Never throws: the row stands as underlag either way. */
export async function linkRunRemeasurement(
  supabase: SupabaseClient,
  args: { companyId: string; salaryRunId: string; journalEntryId: string },
): Promise<string | null> {
  const { error } = await supabase
    .from('vacation_liability_remeasurements')
    .update({ journal_entry_id: args.journalEntryId })
    .eq('company_id', args.companyId)
    .eq('salary_run_id', args.salaryRunId)
  return error ? error.message : null
}

/**
 * The business event of a standalone remeasurement or the switch's catch-up
 * (kind payroll.vacation_liability_adjusted), for the posting port. Pure.
 * Dated the as-of date, filed under expense.personnel. No amount: the 2920
 * and 2940 differences can move in opposite directions; the lines carry
 * both. Nothing per employee goes into the evidence. A run's remeasurement
 * is part of the run's own event (payroll.salary_paid) instead.
 */
export function vacationLiabilityRemeasureEvent(
  plan: RemeasurePlan,
  remeasurementId: string,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  const only = plan.rows.length === 1 ? plan.rows[0] : null
  return {
    kind: 'payroll.vacation_liability_adjusted',
    category: categoryForTemplateGroup('personnel'),
    occurredOn: plan.as_of_date,
    party: only ? { type: 'employee', id: only.employee_id } : null,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('vacationLiabilityRemeasure'),
    jurisdiction: 'SE',
    idempotencyKey: `payroll.vacation_liability_adjusted:remeasurement:${remeasurementId}`,
  }
}
