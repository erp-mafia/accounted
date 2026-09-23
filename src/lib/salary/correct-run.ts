/**
 * Shared salary-run correction orchestration (rättelsekörning).
 *
 * `correctSalaryRun` is the correction core extracted from the dashboard's
 * `POST /api/salary/runs/{id}/correct` route, shared with the v1 verb
 * `POST /api/v1/companies/{companyId}/salary-runs/{id}/correct`.
 *
 * Per BFL 5 kap 5 § a posted verifikation is never edited or deleted: the
 * original run's journal entries are cancelled with storno reversals through
 * `reverseEntry()` (the bookkeeping engine assigns the reversal voucher
 * numbers atomically) and a fresh draft run for the same period replaces it.
 * Both the original and the correction stay visible in the journal.
 *
 * Order of operations (identical to the dashboard route it replaces):
 *
 *   1. Load the run (company-scoped) and check preconditions:
 *      not found / not booked / already corrected.
 *   2. Storno every journal entry the run points at, in the fixed order
 *      salary, avgifter, vacation, pension. An entry a concurrent call
 *      already reversed (EntryAlreadyReversedError) is skipped.
 *   3. Mark the original run `corrected`.
 *   4. Revoke the original's emailed payslip links (they now show "ersatt").
 *   5. Insert the correction run: same period, payment date, deviation
 *      period and voucher series, `is_correction = true`, `corrects_run_id`.
 *   6. Copy the original roster and line items onto the correction run so
 *      the operator edits a populated draft (provenance columns survive so a
 *      recalculation does not derive benefits/recurring rows a second time).
 *   7. Sync the vacation ledger for the affected employees (non-fatal).
 *
 * Failure states (there is no transaction around steps 2-6; the caller
 * must know what a failure leaves behind):
 *
 *   - Precondition failure (steps 1) or dry run: nothing is written.
 *   - Reversal failure in step 2 (`REVERSAL_FAILED`): the storno entries
 *     posted before the failing one are live and immutable (each storno is
 *     its own committed verifikation), the failing and later originals are
 *     still posted, the run is still `booked`, no links are revoked and no
 *     correction run exists. `details.reversed_entry_ids` names the entries
 *     already reversed. A retry skips those (CannotReverseNonPostedError with
 *     currentStatus 'reversed' and the concurrent-race
 *     EntryAlreadyReversedError both count as done) and continues with the
 *     remaining stornos, so the verb can be called again until it succeeds.
 *   - Insert failure in step 5: every original entry is reversed, the run
 *     is already `corrected`, the payslip links are revoked, but no
 *     correction run exists. Calling the verb again resumes at step 5 (the
 *     run is `corrected` with no correction child), so the draft is created
 *     without touching the ledger again. A unique-index conflict (23505,
 *     `SALARY_RUN_ALREADY_CORRECTED` with reason `period_conflict`) means a
 *     live run for the period already exists: in practice a concurrent
 *     correct call that won the insert, in which case that run IS the
 *     correction and nothing is lost. Any other DB error (`DB_ERROR`, stage
 *     `insert_correction_run`) leaves the same state; the operator creates
 *     the correction run by hand (POST /salary-runs with the same period).
 *   - Roster copy or vacation-ledger failure after step 5 is non-fatal:
 *     the correction run exists and the caller gets `ok: true` with
 *     `warnings`; the operator re-attaches missing employees.
 *
 * Every query filters by company_id (defense in depth alongside RLS: the
 * v1 surface runs on a service-role client).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { CannotReverseNonPostedError, EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'
import { revokeLinksForRun } from '@/lib/salary/payslips/links'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'

/** The salary_runs columns the orchestration reads or copies. */
export interface CorrectableSalaryRunRow extends Record<string, unknown> {
  id: string
  company_id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string | null
  deviation_period_start: string | null
  deviation_period_end: string | null
  salary_entry_id: string | null
  avgifter_entry_id: string | null
  vacation_entry_id: string | null
  pension_entry_id: string | null
}

/** The inserted correction run as PostgREST returns it (`select()` on insert). */
export interface CorrectionSalaryRunRow extends Record<string, unknown> {
  id: string
  company_id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string | null
  deviation_period_start: string | null
  deviation_period_end: string | null
  is_correction: boolean
  corrects_run_id: string | null
  notes: string | null
}

export interface CorrectSalaryRunPreview {
  original_run: {
    id: string
    /** `corrected` when the call resumes a correction whose draft was never created. */
    status: 'booked' | 'corrected'
    period_year: number
    period_month: number
    payment_date: string
    voucher_series: string | null
    deviation_period_start: string | null
    deviation_period_end: string | null
  }
  /** Original journal entries the live call would storno, in reversal order. */
  entries_to_reverse: string[]
  /** The draft the live call would insert. */
  correction_run: {
    period_year: number
    period_month: number
    payment_date: string
    voucher_series: string | null
    deviation_period_start: string | null
    deviation_period_end: string | null
    status: 'draft'
    is_correction: true
    corrects_run_id: string
  }
}

export type CorrectSalaryRunLiveResult = {
  ok: true
  dryRun: false
  originalRunId: string
  correctionRun: CorrectionSalaryRunRow
  /** Original entries that are reversed after this call (including ones a concurrent call reversed first). */
  reversedEntryIds: string[]
  /** ISO timestamp taken when the original was marked `corrected`. */
  stampedAt: string
  /** Non-fatal problems after the correction run existed (roster copy, ledger sync). */
  warnings: string[]
}

export type CorrectSalaryRunDryRunResult = {
  ok: true
  dryRun: true
  preview: CorrectSalaryRunPreview
}

export type CorrectSalaryRunFailure =
  | { ok: false; code: 'SALARY_RUN_NOT_FOUND' }
  | { ok: false; code: 'SALARY_RUN_CORRECT_NOT_BOOKED'; details: { current_status: string } }
  | {
      ok: false
      code: 'SALARY_RUN_ALREADY_CORRECTED'
      details: {
        current_status: string
        correction_run_id: string | null
        /**
         * `status_corrected`: the run is already `corrected` (precondition,
         * nothing written). `period_conflict`: the correction-run insert hit
         * the one-live-run-per-period index AFTER the storno and status flip
         * (see the failure-state notes in the module doc).
         */
        reason: 'status_corrected' | 'period_conflict'
      }
    }
  | {
      /**
       * Database error passthrough: never sent as a code. Callers map `error`
       * through their own envelope (errorResponse / v1ErrorResponse).
       */
      ok: false
      code: 'DB_ERROR'
      stage: 'load_run' | 'insert_correction_run'
      error: unknown
    }
  | {
      /**
       * `reverseEntry` threw for `details.entry_id`. `error` is the thrown
       * value (usually a bookkeeping error such as PERIOD_LOCKED or
       * CANNOT_REVERSE_NON_POSTED); callers map it through their envelope.
       */
      ok: false
      code: 'REVERSAL_FAILED'
      error: unknown
      details: {
        /** The entry whose storno threw. */
        entry_id: string
        /** Entries already reversed by this call (live, immutable stornos). */
        reversed_entry_ids: string[]
        /** Entries after the failing one; still posted, never attempted. */
        remaining_entry_ids: string[]
      }
    }

export type CorrectSalaryRunResult =
  | CorrectSalaryRunLiveResult
  | CorrectSalaryRunDryRunResult
  | CorrectSalaryRunFailure

export interface CorrectSalaryRunArgs {
  companyId: string
  userId: string
  runId: string
  /** Validate preconditions and return the preview without writing anything. */
  dryRun?: boolean
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'

function entryIdsOf(run: CorrectableSalaryRunRow): string[] {
  return [
    run.salary_entry_id,
    run.avgifter_entry_id,
    run.vacation_entry_id,
    run.pension_entry_id,
  ].filter((id): id is string => Boolean(id))
}

function correctionNotes(run: CorrectableSalaryRunRow): string {
  return `Korrigering av lönekörning ${run.period_year}-${String(run.period_month).padStart(2, '0')}`
}

export function correctSalaryRun(
  supabase: SupabaseClient,
  args: CorrectSalaryRunArgs & { dryRun: true },
): Promise<CorrectSalaryRunDryRunResult | CorrectSalaryRunFailure>
export function correctSalaryRun(
  supabase: SupabaseClient,
  args: CorrectSalaryRunArgs & { dryRun?: false },
): Promise<CorrectSalaryRunLiveResult | CorrectSalaryRunFailure>
export function correctSalaryRun(
  supabase: SupabaseClient,
  args: CorrectSalaryRunArgs,
): Promise<CorrectSalaryRunResult>
export async function correctSalaryRun(
  supabase: SupabaseClient,
  args: CorrectSalaryRunArgs,
): Promise<CorrectSalaryRunResult> {
  const { companyId, userId, runId } = args

  // 1. Load the run and check preconditions. No status filter on the query:
  //    the caller gets a distinct answer for missing / not booked / corrected.
  const { data: runRow, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', runId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (runError) {
    return { ok: false, code: 'DB_ERROR', stage: 'load_run', error: runError }
  }
  if (!runRow) {
    return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  }
  const originalRun = runRow as CorrectableSalaryRunRow

  // A run already marked `corrected` normally has its correction run; point
  // the caller there. Without one, an earlier call reversed the entries and
  // flipped the status but failed to insert the draft (or the draft was
  // deleted): resume at step 5 instead of leaving the run uncorrectable.
  let resume = false
  if (originalRun.status === 'corrected') {
    const { data: existing } = await supabase
      .from('salary_runs')
      .select('id')
      .eq('company_id', companyId)
      .eq('corrects_run_id', runId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const existingId = (existing as { id: string } | null)?.id ?? null
    if (existingId) {
      return {
        ok: false,
        code: 'SALARY_RUN_ALREADY_CORRECTED',
        details: {
          current_status: originalRun.status,
          correction_run_id: existingId,
          reason: 'status_corrected',
        },
      }
    }
    resume = true
  }
  if (!resume && originalRun.status !== 'booked') {
    return {
      ok: false,
      code: 'SALARY_RUN_CORRECT_NOT_BOOKED',
      details: { current_status: originalRun.status },
    }
  }

  const entryIds = entryIdsOf(originalRun)

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        original_run: {
          id: originalRun.id,
          status: resume ? 'corrected' : 'booked',
          period_year: originalRun.period_year,
          period_month: originalRun.period_month,
          payment_date: originalRun.payment_date,
          voucher_series: originalRun.voucher_series ?? null,
          deviation_period_start: originalRun.deviation_period_start ?? null,
          deviation_period_end: originalRun.deviation_period_end ?? null,
        },
        entries_to_reverse: resume ? [] : entryIds,
        correction_run: {
          period_year: originalRun.period_year,
          period_month: originalRun.period_month,
          payment_date: originalRun.payment_date,
          voucher_series: originalRun.voucher_series ?? null,
          deviation_period_start: originalRun.deviation_period_start ?? null,
          deviation_period_end: originalRun.deviation_period_end ?? null,
          status: 'draft',
          is_correction: true,
          corrects_run_id: originalRun.id,
        },
      },
    }
  }

  // 2. Storno every original entry (BFL 5 kap 5 §). Each reverseEntry call
  //    is its own committed verifikation; see the module doc for the state a
  //    mid-loop failure leaves.
  const reversedEntryIds: string[] = resume ? [...entryIds] : []
  const warnings: string[] = []
  const stampedAt = new Date().toISOString()
  if (!resume) {
  for (const [index, entryId] of entryIds.entries()) {
    try {
      await reverseEntry(supabase, companyId, userId, entryId)
    } catch (err) {
      // Already reversed: by a concurrent call (EntryAlreadyReversedError) or
      // by an earlier attempt of this verb that failed further down the loop
      // (the entry is then in status 'reversed'). Either way the outcome is
      // the one we want, so a retry resumes instead of dead-ending.
      if (
        err instanceof EntryAlreadyReversedError ||
        (err instanceof CannotReverseNonPostedError && err.currentStatus === 'reversed')
      ) {
        reversedEntryIds.push(entryId)
        continue
      }
      return {
        ok: false,
        code: 'REVERSAL_FAILED',
        error: err,
        details: {
          entry_id: entryId,
          reversed_entry_ids: [...reversedEntryIds],
          remaining_entry_ids: entryIds.slice(index + 1),
        },
      }
    }
    reversedEntryIds.push(entryId)
  }

  // 3. Mark the original as corrected. The dashboard route never failed the
  //    request on this update; a failure surfaces as a warning and the insert
  //    below then hits the period index (period_conflict), which is the
  //    signal the operator acts on.
  const { error: markError } = await supabase
    .from('salary_runs')
    .update({ status: 'corrected' })
    .eq('id', runId)
    .eq('company_id', companyId)
  if (markError) {
    warnings.push(`original run status flip failed: ${markError.message}`)
  }

  // 4. Previously emailed payslip links for the original must stop resolving
  //    (they show as "ersatt"). Fresh links are issued when the correction
  //    run's payslips are sent.
  await revokeLinksForRun(supabase, runId)
  }

  // 5. Create the correction run for the same period. The partial unique
  //    index idx_salary_runs_period_unique excludes status 'corrected', so
  //    the original no longer conflicts.
  const { data: correctionRow, error: createError } = await supabase
    .from('salary_runs')
    .insert({
      company_id: companyId,
      user_id: userId,
      period_year: originalRun.period_year,
      period_month: originalRun.period_month,
      payment_date: originalRun.payment_date,
      // A correction re-reads the same calendar as the run it replaces.
      deviation_period_start: originalRun.deviation_period_start ?? null,
      deviation_period_end: originalRun.deviation_period_end ?? null,
      voucher_series: originalRun.voucher_series,
      is_correction: true,
      corrects_run_id: originalRun.id,
      notes: correctionNotes(originalRun),
    })
    .select()
    .single()

  if (createError) {
    if ((createError as { code?: string }).code === UNIQUE_VIOLATION) {
      return {
        ok: false,
        code: 'SALARY_RUN_ALREADY_CORRECTED',
        details: {
          current_status: 'corrected',
          correction_run_id: null,
          reason: 'period_conflict',
        },
      }
    }
    return { ok: false, code: 'DB_ERROR', stage: 'insert_correction_run', error: createError }
  }
  const correctionRun = correctionRow as CorrectionSalaryRunRow

  // 6. Copy the roster (with the engine's snapshot columns) and line items.
  const { data: originalEmployees, error: rosterError } = await supabase
    .from('salary_run_employees')
    .select('*, line_items:salary_line_items(*)')
    .eq('salary_run_id', runId)
    .eq('company_id', companyId)
  if (rosterError) {
    warnings.push(`roster copy skipped: ${rosterError.message}`)
  }

  const roster = (originalEmployees || []) as Array<Record<string, unknown>>
  for (const origEmp of roster) {
    const { data: newSre } = await supabase
      .from('salary_run_employees')
      .insert({
        salary_run_id: correctionRun.id,
        employee_id: origEmp.employee_id,
        company_id: companyId,
        employment_degree: origEmp.employment_degree,
        monthly_salary: origEmp.monthly_salary,
        salary_type: origEmp.salary_type,
        hours_worked: origEmp.hours_worked,
        tax_table_number: origEmp.tax_table_number,
        tax_column: origEmp.tax_column,
      })
      .select()
      .single()

    if (!newSre) {
      warnings.push(`employee ${String(origEmp.employee_id)} was not copied to the correction run`)
      continue
    }

    const lineItems = (origEmp.line_items || []) as Array<Record<string, unknown>>
    for (const li of lineItems) {
      await supabase.from('salary_line_items').insert({
        salary_run_employee_id: (newSre as { id: string }).id,
        company_id: companyId,
        item_type: li.item_type,
        description: li.description,
        quantity: li.quantity,
        unit_price: li.unit_price,
        amount: li.amount,
        is_taxable: li.is_taxable,
        is_avgift_basis: li.is_avgift_basis,
        is_vacation_basis: li.is_vacation_basis,
        is_gross_deduction: li.is_gross_deduction,
        is_net_deduction: li.is_net_deduction,
        account_number: li.account_number,
        sort_order: li.sort_order,
        // Provenance must survive the copy: without these back-links a
        // recalculation of the correction run treats the copied derived
        // rows as manual and step 8d/8d3 derives them a second time.
        source_benefit_id: li.source_benefit_id ?? null,
        source_recurring_line_id: li.source_recurring_line_id ?? null,
      })
    }
  }

  // 7. Vacation ledger sync: the original flipped to 'corrected', so its
  //    vacation_days_taken drop out of the recomputed taken_days. Non-fatal:
  //    the ledger self-heals when the correction run books.
  const ledgerSync = await syncVacationLedgerForEmployees(
    supabase,
    companyId,
    roster.map((sre) => sre.employee_id as string),
  )
  if (!ledgerSync.ok) {
    warnings.push(`vacation ledger sync failed: ${ledgerSync.message}`)
  }

  return {
    ok: true,
    dryRun: false,
    originalRunId: originalRun.id,
    correctionRun,
    reversedEntryIds,
    stampedAt,
    warnings,
  }
}
