/**
 * Shared salary-run booking orchestration.
 *
 * `bookPaidSalaryRun` is the booking core extracted from the dashboard's
 * `POST /api/salary/runs/{id}/book` route: load the paid run + roster,
 * handle the nollkörning branch (zero-amount runs post nothing: the engine
 * forbids zero vouchers), otherwise post 2-4 verifikationer via
 * `createSalaryRunEntries()`, advance `paid` → `booked`, emit
 * `salary_run.booked`, and sync the vacation ledger (non-fatal).
 *
 * `advanceAndBookSalaryRun` is the pending-operation executor path for the
 * MCP tool `gnubok_book_salary_run`: the human approval of the staged
 * operation is the authorization act, so it walks a calculated run through
 * the remaining statuses (draft → review → approved → paid) with the same
 * validations the dashboard routes apply, then books. Missing bank details
 * surface as warnings rather than blockers (mirroring the dashboard's
 * force-approve path): the payment-file generators hard-block on them where
 * it actually matters.
 *
 * Bookkeeping-engine errors (period locks, unbalanced entries) THROW out of
 * both functions: callers map them via their own envelope, exactly like the
 * route did before extraction. The v1 route keeps its own strict-mode mirror
 * (optimistic locking, period pre-check) on purpose.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createSalaryRunEntries } from '@/lib/salary/salary-entries'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'
import { effectiveNetPayout } from '@/lib/salary/payment/effective-net'
import { eventBus } from '@/lib/events'

export type BookRunResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown>; dbError?: unknown }

export interface BookedRunData {
  run: Record<string, unknown>
  entryIds: string[]
  nollkorning: boolean
}

interface BookRunArgs {
  companyId: string
  userId: string
  salaryRunId: string
  log: Logger
}

const ROSTER_SELECT =
  '*, employee:employees(first_name, last_name, employment_type, default_dimensions, f_skatt_status, clearing_number, bank_account_number, email)'

type RosterRow = Record<string, unknown> & {
  employee_id: string
  net_salary: number
  tax_withheld: number
  tax_withheld_override: number | null
  employee: {
    first_name: string
    last_name: string
    employment_type: string | null
    default_dimensions: Record<string, string> | null
    f_skatt_status: string | null
    clearing_number: string | null
    bank_account_number: string | null
    email: string | null
  } | null
  line_items: Array<Record<string, unknown>> | null
}

async function loadRoster(
  supabase: SupabaseClient,
  salaryRunId: string,
): Promise<BookRunResult<RosterRow[]>> {
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select(`${ROSTER_SELECT}, line_items:salary_line_items(*)`)
    .eq('salary_run_id', salaryRunId)
  if (error) {
    return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: error }
  }
  return { ok: true, data: (data ?? []) as RosterRow[] }
}

async function bookLoadedRun(
  supabase: SupabaseClient,
  { companyId, userId, salaryRunId, log }: BookRunArgs,
  run: Record<string, unknown>,
  roster: RosterRow[],
): Promise<BookRunResult<BookedRunData>> {
  // Nollkörning: a run with no monetary effect (employees set to 0 kr, or no
  // roster at all) has nothing to post. The bookkeeping engine forbids
  // zero-amount vouchers (every entry must balance with debit & credit > 0),
  // so we skip journal-entry creation entirely and just advance to 'booked'.
  // The AGI nolldeklaration is then the only artefact for the period.
  const nothingToBook =
    Math.round(((run.total_gross as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_tax as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_avgifter as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_vacation_accrual as number) ?? 0) * 100) === 0

  if (nothingToBook) {
    const { data: bookedRun, error: updateError } = await supabase
      .from('salary_runs')
      .update({
        status: 'booked',
        booked_at: new Date().toISOString(),
        booked_by: userId,
      })
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .select()
      .single()

    if (updateError) {
      return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: updateError }
    }

    await eventBus.emit({
      type: 'salary_run.booked',
      payload: { salaryRunId, entryIds: [], userId, companyId },
    })

    // Vacation ledger sync (non-fatal: the ledger recomputes and self-heals
    // on the next booking; a sync bug must never block a booking).
    const nollSync = await syncVacationLedgerForEmployees(
      supabase,
      companyId,
      roster.map((sre) => sre.employee_id),
    )
    if (!nollSync.ok) {
      log.warn('vacation ledger sync failed after nollkörning booking', { message: nollSync.message })
    }

    log.info('salary run booked as nollkörning (no journal entries)', { salaryRunId })
    return { ok: true, data: { run: bookedRun, entryIds: [], nollkorning: true } }
  }

  const { salaryEntry, avgifterEntry, vacationEntry, pensionEntry } = await createSalaryRunEntries(
    supabase,
    companyId,
    userId,
    {
      id: run.id as string,
      period_year: run.period_year as number,
      period_month: run.period_month as number,
      payment_date: run.payment_date as string,
      voucher_series: run.voucher_series as string,
      total_gross: run.total_gross as number,
      total_tax: run.total_tax as number,
      total_net: run.total_net as number,
      total_avgifter: run.total_avgifter as number,
      total_vacation_accrual: run.total_vacation_accrual as number,
      // Use the exact payroll-rate snapshot approved with this run. Reading
      // current config here could change SLP between calculation and booking.
      calculation_params: run.calculation_params as Record<string, unknown> | null,
      employees: roster.map((sre) => ({
        employee_id: sre.employee_id,
        employment_type: sre.employee?.employment_type || 'employee',
        gross_salary: sre.gross_salary as number,
        // Apply per-employee overrides (advanced mode) so manual
        // adjustments for FoU-avdrag / jämkning flow into the ledger.
        tax_withheld: (sre.tax_withheld_override as number | null) ?? (sre.tax_withheld as number),
        net_salary:
          (sre.net_salary as number) +
          ((sre.tax_withheld as number) -
            ((sre.tax_withheld_override as number | null) ?? (sre.tax_withheld as number))),
        avgifter_amount:
          (sre.avgifter_amount_override as number | null) ?? (sre.avgifter_amount as number),
        avgifter_rate: sre.avgifter_rate as number,
        vacation_accrual: sre.vacation_accrual as number,
        vacation_accrual_avgifter: sre.vacation_accrual_avgifter as number,
        // Dimensions PR8: read-at-book from the employee row, the run
        // review shows the same live bag, so preview matches booking.
        default_dimensions: sre.employee?.default_dimensions ?? undefined,
        line_items: (sre.line_items || []).map((li: Record<string, unknown>) => ({
          item_type: li.item_type as string,
          amount: li.amount as number,
          account_number: li.account_number as string | null,
          is_net_deduction: li.is_net_deduction as boolean,
          is_gross_deduction: li.is_gross_deduction as boolean,
        })),
      })),
    },
  )

  const entryIds = [salaryEntry.id, avgifterEntry.id]
  const updates: Record<string, unknown> = {
    status: 'booked',
    salary_entry_id: salaryEntry.id,
    avgifter_entry_id: avgifterEntry.id,
    booked_at: new Date().toISOString(),
    booked_by: userId,
  }
  if (vacationEntry) {
    updates.vacation_entry_id = vacationEntry.id
    entryIds.push(vacationEntry.id)
  }
  if (pensionEntry) {
    updates.pension_entry_id = pensionEntry.id
    entryIds.push(pensionEntry.id)
  }

  const { data: bookedRun, error: updateError } = await supabase
    .from('salary_runs')
    .update(updates)
    .eq('id', salaryRunId)
    .select()
    .single()

  if (updateError) {
    return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: updateError }
  }

  await eventBus.emit({
    type: 'salary_run.booked',
    payload: { salaryRunId, entryIds, userId, companyId },
  })

  // Vacation ledger sync (non-fatal, see the nollkörning branch).
  const ledgerSync = await syncVacationLedgerForEmployees(
    supabase,
    companyId,
    roster.map((sre) => sre.employee_id),
  )
  if (!ledgerSync.ok) {
    log.warn('vacation ledger sync failed after booking', { message: ledgerSync.message })
  }

  return { ok: true, data: { run: bookedRun, entryIds, nollkorning: false } }
}

/**
 * paid → booked. Exact semantics of the dashboard book route: the run must
 * already be in 'paid' status.
 */
export async function bookPaidSalaryRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
): Promise<BookRunResult<BookedRunData>> {
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', args.salaryRunId)
    .eq('company_id', args.companyId)
    .eq('status', 'paid')
    .single()

  if (runError || !run) {
    return {
      ok: false,
      code: 'SALARY_RUN_NOT_CALCULATED',
      details: { reason: 'must_be_paid_status' },
    }
  }

  const roster = await loadRoster(supabase, args.salaryRunId)
  if (!roster.ok) return roster

  return bookLoadedRun(supabase, args, run, roster.data)
}

export interface AdvanceAndBookData extends BookedRunData {
  warnings: string[]
}

/**
 * Walk a calculated salary run through review → approved → paid → booked.
 *
 * Used by the `book_salary_run` pending-operation executor: the staged
 * operation's human approval covers the authorization the dashboard collects
 * per-status. Validation parity with the dashboard routes:
 *   - every roster row must carry a calculation_breakdown (blocking)
 *   - missing bank details (for a positive net payout) and missing email are
 *     warnings, not blockers (dashboard force-approve semantics)
 *   - F-skatt not verified surfaces as a warning (review route parity)
 */
export async function advanceAndBookSalaryRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
): Promise<BookRunResult<AdvanceAndBookData>> {
  const { companyId, userId, salaryRunId } = args

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .single()

  if (runError || !run) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }

  let status = run.status as string
  if (status === 'booked') {
    return { ok: false, code: 'SALARY_RUN_ALREADY_BOOKED' }
  }
  if (!['draft', 'review', 'approved', 'paid'].includes(status)) {
    return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', details: { reason: `unknown status: ${status}` } }
  }

  const rosterResult = await loadRoster(supabase, salaryRunId)
  if (!rosterResult.ok) return rosterResult
  const roster = rosterResult.data

  const warnings: string[] = []

  if (status === 'draft' || status === 'review') {
    // Blocking: a roster row without a calculation would post a wrong
    // verifikation. Same gate as the dashboard approve route.
    const uncalculated = roster
      .filter((sre) => !sre.calculation_breakdown)
      .map((sre) => `${sre.employee?.first_name ?? ''} ${sre.employee?.last_name ?? ''}`.trim() || sre.employee_id)
    if (uncalculated.length > 0) {
      return {
        ok: false,
        code: 'SALARY_RUN_NOT_CALCULATED',
        details: { employees: uncalculated },
      }
    }

    for (const sre of roster) {
      const emp = sre.employee
      if (!emp) continue
      const name = `${emp.first_name} ${emp.last_name}`
      if (emp.f_skatt_status === 'not_verified') {
        warnings.push(
          `${name}: F-skatt ej verifierad: 30% skatteavdrag och fulla avgifter tillämpas (f-skatt.md)`,
        )
      }
      if (effectiveNetPayout(sre) > 0 && (!emp.clearing_number || !emp.bank_account_number)) {
        warnings.push(`${name}: Bankuppgifter saknas (clearingnummer och/eller kontonummer)`)
      }
      if (!emp.email) {
        warnings.push(`${name}: E-post saknas, lönebesked kan inte skickas`)
      }
    }
  }

  if (status === 'draft') {
    const { data: reviewed, error } = await supabase
      .from('salary_runs')
      .update({ status: 'review' })
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .select('id')
      .single()
    if (error || !reviewed) {
      return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: error ?? undefined }
    }
    status = 'review'
  }

  if (status === 'review') {
    const { data: approved, error } = await supabase
      .from('salary_runs')
      .update({
        status: 'approved',
        approved_by: userId,
        approved_at: new Date().toISOString(),
      })
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .eq('status', 'review')
      .select('id')
      .single()
    if (error || !approved) {
      return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: error ?? undefined }
    }
    await eventBus.emit({
      type: 'salary_run.approved',
      payload: { salaryRunId, approvedBy: userId, userId, companyId },
    })
    status = 'approved'
  }

  if (status === 'approved') {
    const { data: paid, error } = await supabase
      .from('salary_runs')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .eq('status', 'approved')
      .select('id')
      .single()
    if (error || !paid) {
      return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: error ?? undefined }
    }
    status = 'paid'
  }

  const booked = await bookLoadedRun(supabase, args, run, roster)
  if (!booked.ok) return booked
  return { ok: true, data: { ...booked.data, warnings } }
}
