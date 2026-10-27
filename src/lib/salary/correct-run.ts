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
 * Both the original and the correction stay visible in the journal. The
 * stornos go through the posting port (reverseJournalEntry): while
 * POSTING_EVENTS is shadow or strict, the run's correction is one business
 * event (salaryRunCorrectionBusinessEvent) linked to every storno before its
 * voucher number is drawn.
 *
 * Order of operations (identical to the dashboard route it replaces):
 *
 *   1. Load the run (company-scoped) and check preconditions:
 *      not found / not booked / already corrected.
 *   2. Storno every journal entry the run points at, in the fixed order
 *      salary, avgifter, vacation, pension. An entry a concurrent call
 *      already reversed (EntryAlreadyReversedError) is skipped. An entry
 *      someone corrected with storno + rättelse is reversed already, but its
 *      pay lives on in the rättelse: that posted rättelse is stornoed in its
 *      place (postedRattelserOf), or the correction run books the period a
 *      second time.
 *   3. Mark the original run `corrected`.
 *   4. Revoke the original's emailed payslip links (they now show "ersatt").
 *   5. Insert the correction run: same period, payment date, deviation
 *      period and voucher series, `is_correction = true`, `corrects_run_id`.
 *   6. Copy the original roster and line items onto the correction run so
 *      the operator edits a populated draft: every column but identity,
 *      timestamps, the parent link, the calculation proof and the utlägg
 *      claim link (provenance survives so a recalculation does not derive
 *      engine rows a second time).
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
 *   - Roster copy failure in step 6 (`DB_ERROR`, stage `copy_roster`): the
 *     correction run is deleted again (a fresh draft, nothing references
 *     it), which leaves the step 5 insert-failure state; calling the verb
 *     again resumes at step 5. Should that delete fail too, the half-copied
 *     draft remains: delete it (it is a draft) and call again.
 *   - Vacation-ledger failure in step 7 is non-fatal: the caller gets
 *     `ok: true` with `warnings`.
 *
 * Every query filters by company_id (defense in depth alongside RLS: the
 * v1 surface runs on a service-role client).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { CannotReverseNonPostedError, EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { isCachedDefaultAccount } from '@/lib/salary/account-mapping'
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
  /**
   * Journal entries the live call would storno, in reversal order: the run's
   * posted entries, and for one already corrected with storno + rättelse the
   * posted rättelse that replaced it.
   */
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
  /**
   * Entries that are reversed after this call: the run's own (including ones
   * a concurrent call reversed first) and any posted rättelse of them it
   * stornoed in their place.
   */
  reversedEntryIds: string[]
  /** ISO timestamp taken when the original was marked `corrected`. */
  stampedAt: string
  /** Non-fatal problems after the correction run existed (status flip, ledger sync). */
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
      stage: 'load_run' | 'insert_correction_run' | 'copy_roster'
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

/**
 * The business event of a salary run's correction (kind ledger.storno, role
 * reversal), for the posting port: ONE event for the stornos of every
 * verifikat of the run, recorded while POSTING_EVENTS is shadow or strict and
 * never built while it is off. Pure. The subject is the corrected run; the
 * act is dated the day the correction is made, as the removal of an utlägg
 * is. No party, no amount and no rule version: a storno mirrors the run's own
 * lines, the run names its employees, and the correction run booked later
 * records its own payroll.salary_paid event. Each storno call passes the same
 * idempotency key, so the first records the event and every later storno of
 * the run, in this call or in a retry, is linked to that same event.
 */
export function salaryRunCorrectionBusinessEvent(
  runId: string,
  occurredOn: string,
  linkBasis: LinkBasisColumns,
): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    occurredOn,
    subject: { type: 'salary_run', id: runId },
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    jurisdiction: 'SE',
    idempotencyKey: `ledger.storno:salary_run:${runId}`,
  }
}

function entryIdsOf(run: CorrectableSalaryRunRow): string[] {
  return [
    run.salary_entry_id,
    run.avgifter_entry_id,
    run.vacation_entry_id,
    run.pension_entry_id,
  ].filter((id): id is string => Boolean(id))
}

/** Deepest rättelse-of-a-rättelse chain followed; real chains are one or two long. */
const MAX_RATTELSE_DEPTH = 10

/**
 * The posted rättelser that replace `entryId`. Correcting a run verifikat with
 * storno + rättelse (storno-service: the original is reversed and a new
 * verifikat carries correction_of_id = the original) leaves the run pointing at
 * the reversed original while the pay lives on in the rättelse. A rättelse can
 * itself be corrected, so the chain is followed down to what is posted now.
 */
async function postedRattelserOf(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: unknown }> {
  const posted: string[] = []
  let frontier = [entryId]
  for (let depth = 0; depth < MAX_RATTELSE_DEPTH && frontier.length > 0; depth++) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status')
      .eq('company_id', companyId)
      .in('correction_of_id', frontier)
    if (error) return { ok: false, error }
    const rows = (data || []) as Array<{ id: string; status: string }>
    posted.push(...rows.filter((row) => row.status === 'posted').map((row) => row.id))
    frontier = rows.filter((row) => row.status === 'reversed').map((row) => row.id)
  }
  return { ok: true, ids: posted }
}

/** An entry that is already reversed: by a concurrent call, an earlier attempt or a user's storno. */
function isAlreadyReversed(err: unknown): boolean {
  return (
    err instanceof EntryAlreadyReversedError ||
    (err instanceof CannotReverseNonPostedError && err.currentStatus === 'reversed')
  )
}

/**
 * What the live call would storno, for the preview: each posted run entry, and
 * for a reversed one the posted rättelser that replace it. Read-only.
 */
async function entriesToReverse(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: unknown }> {
  if (entryIds.length === 0) return { ok: true, ids: [] }
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, status')
    .eq('company_id', companyId)
    .in('id', entryIds)
  if (error) return { ok: false, error }
  const statusById = new Map(((data || []) as Array<{ id: string; status: string }>).map((row) => [row.id, row.status]))
  const ids: string[] = []
  for (const entryId of entryIds) {
    if (statusById.get(entryId) !== 'reversed') {
      ids.push(entryId)
      continue
    }
    const replacements = await postedRattelserOf(supabase, companyId, entryId)
    if (!replacements.ok) return replacements
    ids.push(...replacements.ids)
  }
  return { ok: true, ids }
}

function correctionNotes(run: CorrectableSalaryRunRow): string {
  return `Korrigering av lönekörning ${run.period_year}-${String(run.period_month).padStart(2, '0')}`
}

/**
 * Copies `row` without its own identity and timestamps (the database assigns
 * fresh ones) and without the `omit` columns. Everything else is copied as
 * it is, so a column added to the table later survives the correction
 * without anyone remembering to list it here.
 */
function copyColumns(row: Record<string, unknown>, omit: string[]): Record<string, unknown> {
  const skip = new Set(['id', 'created_at', 'updated_at', ...omit])
  return Object.fromEntries(Object.entries(row).filter(([column]) => !skip.has(column)))
}

type RosterRow = Record<string, unknown> & {
  employee_id: string
  employee?: { employment_type?: string | null } | null
  line_items?: Array<Record<string, unknown>>
}

/**
 * Step 6: the original roster (snapshots, overrides, AGI flags) and every
 * line item onto the correction run, one bulk insert each, uncalculated.
 * Line provenance (calculation_source, source_benefit_id,
 * source_recurring_line_id) must survive: without it a recalculation treats
 * the copied engine rows as manual pay and derives them a second time.
 *
 * A line account the original run cached as a default (isCachedDefaultAccount,
 * the backfill migration's rule) is not carried either: the correction books
 * on the default resolved at its own booking, like any unbooked run.
 *
 * source_expense_claim_id is the one line column not carried: a partial unique
 * index keeps a claim on one payslip line, the original run's line keeps it,
 * and the original salary verifikat's payout batch already settled the
 * claim. The copied line still repays the amount on its 2820 account.
 */
async function copyRosterToCorrection(
  supabase: SupabaseClient,
  companyId: string,
  originalRunId: string,
  correctionRunId: string,
): Promise<{ ok: true; roster: RosterRow[] } | { ok: false; error: unknown }> {
  const { data: originalEmployees, error: rosterError } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(employment_type), line_items:salary_line_items(*)')
    .eq('salary_run_id', originalRunId)
    .eq('company_id', companyId)
  if (rosterError) return { ok: false, error: rosterError }

  const roster = (originalEmployees || []) as RosterRow[]
  if (roster.length === 0) return { ok: true, roster }

  // calculation_breakdown stays behind: it is the proof that the engine ran
  // against this run's inputs, and approve and book refuse a row without it
  // (calculation-state.ts). The correction has not been calculated yet.
  const { data: copiedEmployees, error: employeeError } = await supabase
    .from('salary_run_employees')
    .insert(
      roster.map((sre) => ({
        ...copyColumns(sre, ['salary_run_id', 'employee', 'line_items', 'calculation_breakdown']),
        salary_run_id: correctionRunId,
        company_id: companyId,
      })),
    )
    .select('id, employee_id')
  if (employeeError) return { ok: false, error: employeeError }

  // UNIQUE (salary_run_id, employee_id): one copied row per employee.
  const copiedIdByEmployee = new Map(
    ((copiedEmployees || []) as Array<{ id: string; employee_id: string }>).map((sre) => [sre.employee_id, sre.id]),
  )
  const lineItems: Array<Record<string, unknown>> = []
  for (const sre of roster) {
    const copiedId = copiedIdByEmployee.get(sre.employee_id)
    if (!copiedId) {
      return { ok: false, error: new Error(`employee ${sre.employee_id} was not copied to the correction run`) }
    }
    const employmentType = sre.employee?.employment_type || 'employee'
    for (const li of sre.line_items || []) {
      const cachedDefault = isCachedDefaultAccount(
        li.item_type as string,
        li.account_number as string | null,
        employmentType,
      )
      lineItems.push({
        ...copyColumns(li, ['salary_run_employee_id']),
        salary_run_employee_id: copiedId,
        company_id: companyId,
        source_expense_claim_id: null,
        ...(cachedDefault ? { account_number: null } : {}),
      })
    }
  }
  if (lineItems.length === 0) return { ok: true, roster }

  const { error: lineError } = await supabase.from('salary_line_items').insert(lineItems)
  if (lineError) return { ok: false, error: lineError }

  return { ok: true, roster }
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
    // Reading the run's verifikat is part of loading the run.
    const toReverse = resume ? { ok: true as const, ids: [] } : await entriesToReverse(supabase, companyId, entryIds)
    if (!toReverse.ok) {
      return { ok: false, code: 'DB_ERROR', stage: 'load_run', error: toReverse.error }
    }
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
        entries_to_reverse: toReverse.ids,
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
  const correctedOn = todayIsoStockholm()
  const storno = (entryId: string) =>
    postingPort.reverseJournalEntry({
      supabase,
      companyId,
      userId,
      entryId,
      // Built only while the port is on: off, reverseEntry gets the call it always did.
      event: () => salaryRunCorrectionBusinessEvent(runId, correctedOn, linkBasisColumns('user_created')),
      role: 'reversal',
    })
  const reversalFailed = (entryId: string, err: unknown, index: number): CorrectSalaryRunFailure => ({
    ok: false,
    code: 'REVERSAL_FAILED',
    error: err,
    details: {
      entry_id: entryId,
      reversed_entry_ids: [...reversedEntryIds],
      remaining_entry_ids: entryIds.slice(index + 1),
    },
  })
  for (const [index, entryId] of entryIds.entries()) {
    try {
      await storno(entryId)
    } catch (err) {
      if (!isAlreadyReversed(err)) return reversalFailed(entryId, err, index)
      // Already reversed: by a concurrent call, by an earlier attempt of this
      // verb that failed further down the loop, or by a user's storno +
      // rättelse. In the last case the pay lives on in the rättelse, so it is
      // stornoed in the original's place; the first two leave none to find.
      const replacements = await postedRattelserOf(supabase, companyId, entryId)
      if (!replacements.ok) return reversalFailed(entryId, replacements.error, index)
      reversedEntryIds.push(entryId)
      for (const replacementId of replacements.ids) {
        try {
          await storno(replacementId)
        } catch (replacementErr) {
          if (!isAlreadyReversed(replacementErr)) return reversalFailed(replacementId, replacementErr, index)
        }
        reversedEntryIds.push(replacementId)
      }
      continue
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

  // 6. Copy the roster and line items. A failure removes the correction run
  //    again: the state is then the one an insert failure in step 5 leaves,
  //    and calling the verb again resumes there. A correction draft missing
  //    employees or lines would otherwise be booked as if it were complete.
  const copy = await copyRosterToCorrection(supabase, companyId, runId, correctionRun.id)
  if (!copy.ok) {
    await supabase
      .from('salary_runs')
      .delete()
      .eq('id', correctionRun.id)
      .eq('company_id', companyId)
    return { ok: false, code: 'DB_ERROR', stage: 'copy_roster', error: copy.error }
  }
  const roster = copy.roster

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
