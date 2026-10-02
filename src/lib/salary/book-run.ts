/**
 * Shared salary-run booking orchestration.
 *
 * `bookPaidSalaryRun` is the booking core extracted from the dashboard's
 * `POST /api/salary/runs/{id}/book` route: load the paid run + roster,
 * handle the nollkörning branch (zero-amount runs post nothing: the engine
 * forbids zero vouchers), otherwise post 2-4 verifikationer via
 * `createSalaryRunEntries()`, advance `paid` → `booked`, emit
 * `salary_run.booked`, and sync the vacation ledger (non-fatal).
 * `createSalaryRunEntries()` posts all of the run's vouchers or none, and a
 * retry after an interrupted posting adopts what is already in the ledger
 * instead of posting it twice, so a run left `paid` is safe to book again.
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
 * Bookkeeping-engine errors (period locks, unbalanced entries) and
 * SalaryRunPartiallyBookedError THROW out of both functions: callers map them
 * via their own envelope, exactly like the route did before extraction. The
 * v1 route keeps its own strict-mode mirror (period pre-check) on purpose,
 * but takes the same booking claim and flips through the same
 * markClaimedRunBooked, so every door is serialized by one invariant.
 *
 * Booking claim (accounted#3251): reading the run as 'paid', posting its
 * vouchers and flipping it to 'booked' are separate round trips, so a read
 * cannot stop a concurrent call from posting the same vouchers. Every booking
 * therefore claims the run first (claimSalaryRunBooking, one conditional
 * UPDATE in the database). Only the claim holder posts, only the holder can
 * flip the run to 'booked', and a holder that fails releases the claim.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import {
  assertLinkedExpenseClaimsOpen,
  rosterHasLinkedExpenseClaims,
  settleExpenseClaimsForBookedRun,
} from '@/lib/salary/expense-claim-lines'
import {
  createSalaryRunEntries,
  salaryRunDataFromRows,
  type SalaryRosterRow,
  type SalaryRunRow,
} from '@/lib/salary/salary-entries'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'
import { refreshRunYtd } from '@/lib/salary/ytd'
import { effectiveNetPayout } from '@/lib/salary/payment/effective-net'
import { employeeBankDetailsRemark } from '@/lib/salary/payment/bank-account'
import { eventBus } from '@/lib/events'

export type BookRunResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown>; dbError?: unknown }

export interface BookedRunData {
  run: Record<string, unknown>
  entryIds: string[]
  nollkorning: boolean
}

export interface BookRunArgs {
  companyId: string
  userId: string
  salaryRunId: string
  log: Logger
}

const ROSTER_SELECT =
  '*, employee:employees(first_name, last_name, employment_type, default_dimensions, f_skatt_status, clearing_number, bank_account_number, email)'

type RosterRow = SalaryRosterRow & Record<string, unknown> & {
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

export type SalaryRunBookingClaim =
  | { ok: true; claimId: string }
  | { ok: false; reason: 'in_progress' }
  | { ok: false; reason: 'not_paid'; currentStatus: string | null }
  | { ok: false; reason: 'db_error'; dbError: unknown }

/**
 * Claim a paid run for this booking call before anything is posted
 * (claim_salary_run_booking). Of two concurrent callers exactly one gets the
 * token; the other learns why it did not: the run is held by a live booking
 * ('in_progress'), or it is no longer paid (booked meanwhile, or never paid).
 * A claim whose call died expires in the database after 15 minutes.
 */
export async function claimSalaryRunBooking(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
): Promise<SalaryRunBookingClaim> {
  const { data: claimId, error } = await supabase.rpc('claim_salary_run_booking', {
    p_company_id: companyId,
    p_salary_run_id: salaryRunId,
  })
  if (error) return { ok: false, reason: 'db_error', dbError: error }
  if (typeof claimId === 'string' && claimId) return { ok: true, claimId }

  const { data: current, error: readError } = await supabase
    .from('salary_runs')
    .select('status')
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (readError) return { ok: false, reason: 'db_error', dbError: readError }
  const currentStatus = (current as { status?: string } | null)?.status ?? null
  if (currentStatus === 'paid') return { ok: false, reason: 'in_progress' }
  return { ok: false, reason: 'not_paid', currentStatus }
}

/**
 * Hand the run back after a booking that did not reach 'booked' (a refusal,
 * an engine throw, a failed flip), so the user can retry at once instead of
 * waiting out the expiry. Conditional on the token: it never touches a claim
 * another call has taken since. Never throws: a claim that stays behind
 * expires on its own.
 */
export async function releaseSalaryRunBooking(
  supabase: SupabaseClient,
  companyId: string,
  salaryRunId: string,
  claimId: string,
  log: Logger,
): Promise<void> {
  try {
    const { error } = await supabase
      .from('salary_runs')
      .update({ booking_claim_id: null, booking_claimed_at: null })
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .eq('booking_claim_id', claimId)
    if (error) {
      log.warn('salary run booking claim not released; it expires on its own', {
        salaryRunId,
        message: error.message,
      })
    }
  } catch (err) {
    log.warn('salary run booking claim not released; it expires on its own', {
      salaryRunId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The run's posted vouchers, as createSalaryRunEntries returns them. */
export interface SalaryRunVoucherIds {
  salaryEntry: { id: string }
  avgifterEntry: { id: string } | null
  vacationEntry: { id: string } | null
  pensionEntry: { id: string } | null
}

/**
 * paid -> booked for the call that holds the booking claim, recording the
 * posted vouchers (none for a nollkörning) and clearing the claim in the same
 * statement. Zero rows updated means the claim was lost: the vouchers are
 * posted but the run does not point at them, so it is an error, logged with
 * the entry ids, never a success.
 */
export async function markClaimedRunBooked(
  supabase: SupabaseClient,
  { companyId, userId, salaryRunId, log }: BookRunArgs,
  claimId: string,
  vouchers: SalaryRunVoucherIds | null,
  columns = '*',
): Promise<BookRunResult<{ run: Record<string, unknown>; entryIds: string[] }>> {
  const entryIds: string[] = []
  const updates: Record<string, unknown> = {
    status: 'booked',
    booked_at: new Date().toISOString(),
    booked_by: userId,
    booking_claim_id: null,
    booking_claimed_at: null,
  }
  if (vouchers) {
    updates.salary_entry_id = vouchers.salaryEntry.id
    entryIds.push(vouchers.salaryEntry.id)
    // No avgifter voucher for a run without avgifter (utlägg-only, F-skatt).
    if (vouchers.avgifterEntry) {
      updates.avgifter_entry_id = vouchers.avgifterEntry.id
      entryIds.push(vouchers.avgifterEntry.id)
    }
    if (vouchers.vacationEntry) {
      updates.vacation_entry_id = vouchers.vacationEntry.id
      entryIds.push(vouchers.vacationEntry.id)
    }
    if (vouchers.pensionEntry) {
      updates.pension_entry_id = vouchers.pensionEntry.id
      entryIds.push(vouchers.pensionEntry.id)
    }
  }

  const { data: bookedRun, error } = await supabase
    .from('salary_runs')
    .update(updates)
    .eq('id', salaryRunId)
    .eq('company_id', companyId)
    .eq('status', 'paid')
    .eq('booking_claim_id', claimId)
    .select(columns)
    .maybeSingle()

  if (error) {
    log.error('salary run status flip to booked failed', error as unknown as Error, {
      salaryRunId,
      companyId,
      entryIds,
    })
    return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: error }
  }
  if (!bookedRun) {
    log.error(
      'salary run booking claim lost before the status flip: posted vouchers are not linked to the run',
      new Error('booking claim lost'),
      { salaryRunId, companyId, entryIds },
    )
    return {
      ok: false,
      code: 'SALARY_RUN_BOOK_FAILED',
      details: { reason: 'booking_claim_lost', entry_ids: entryIds },
    }
  }
  return { ok: true, data: { run: bookedRun as unknown as Record<string, unknown>, entryIds } }
}

function bookingClaimRefusal(
  refusal: Exclude<SalaryRunBookingClaim, { ok: true }>,
): BookRunResult<never> {
  if (refusal.reason === 'db_error') {
    return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: refusal.dbError }
  }
  if (refusal.reason === 'in_progress') return { ok: false, code: 'SALARY_RUN_BOOKING_IN_PROGRESS' }
  if (refusal.currentStatus === 'booked') return { ok: false, code: 'SALARY_RUN_ALREADY_BOOKED' }
  if (refusal.currentStatus === null) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  return { ok: false, code: 'SALARY_RUN_BOOK_NOT_PAID', details: { current_status: refusal.currentStatus } }
}

async function bookLoadedRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
  run: Record<string, unknown>,
  roster: RosterRow[],
): Promise<BookRunResult<BookedRunData>> {
  // Claim first: before the YTD refresh, the utlägg check, the nollkörning
  // branch and the posting, so a concurrent call for the same run posts
  // nothing and does no side work.
  const bookingClaim = await claimSalaryRunBooking(supabase, args.companyId, args.salaryRunId)
  if (!bookingClaim.ok) return bookingClaimRefusal(bookingClaim)

  let result: BookRunResult<BookedRunData> | undefined
  try {
    result = await bookClaimedRun(supabase, args, bookingClaim.claimId, run, roster)
    return result
  } finally {
    // A booked run's flip already cleared the claim; anything else hands the
    // run back so a retry can start at once (and adopts what was posted).
    if (!result?.ok) {
      await releaseSalaryRunBooking(supabase, args.companyId, args.salaryRunId, bookingClaim.claimId, args.log)
    }
  }
}

async function bookClaimedRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
  claimId: string,
  run: Record<string, unknown>,
  roster: RosterRow[],
): Promise<BookRunResult<BookedRunData>> {
  const { companyId, userId, salaryRunId, log } = args
  // Refresh the payslip's "Ackumulerat" snapshot before the status flip. The
  // snapshot was written at calculation time from the months authorized back
  // then; a month authorized since (the normal case when next month's run is
  // prepared early) is missing from it. Non-fatal: YTD is display only and
  // never reaches a verifikation, so a refresh failure must not block a
  // booking.
  const ytdRefresh = await refreshRunYtd(supabase, { companyId, salaryRunId })
  if (!ytdRefresh.ok) {
    log.warn('YTD refresh failed before booking', { salaryRunId, message: ytdRefresh.message })
  }

  // Utlägg repaid with this salary (#2331): every linked claim must still be
  // open BEFORE anything is posted. A refusal here costs nothing; a refusal
  // from the settle step afterwards would leave a posted 2820 debit with no
  // claim behind it.
  const claimsCheck = await assertLinkedExpenseClaimsOpen(supabase, companyId, roster)
  if (!claimsCheck.ok) {
    return { ok: false, code: claimsCheck.code, details: claimsCheck.details }
  }

  // Nollkörning: a run with no monetary effect (employees set to 0 kr, or no
  // roster at all) has nothing to post. The bookkeeping engine forbids
  // zero-amount vouchers (every entry must balance with debit & credit > 0),
  // so we skip journal-entry creation entirely and just advance to 'booked'.
  // The AGI nolldeklaration is then the only artefact for the period. The net
  // is part of the test: a run that only repays utlägg has gross 0 but a
  // payout, and its 2820 D / 1930 K must be posted.
  const nothingToBook =
    Math.round(((run.total_gross as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_tax as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_net as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_avgifter as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_vacation_accrual as number) ?? 0) * 100) === 0

  if (nothingToBook) {
    const flipped = await markClaimedRunBooked(supabase, args, claimId, null)
    if (!flipped.ok) return flipped

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
    return { ok: true, data: { run: flipped.data.run, entryIds: [], nollkorning: true } }
  }

  // Rows -> engine input through the same mapper the journal preview route
  // uses (overrides, F-skatt avgifter rules, dimensions all live there), so
  // the voucher the user approved on screen is the voucher that posts.
  const vouchers = await createSalaryRunEntries(
    supabase,
    companyId,
    userId,
    salaryRunDataFromRows(run as unknown as SalaryRunRow, roster),
  )

  const flipped = await markClaimedRunBooked(supabase, args, claimId, vouchers)
  if (!flipped.ok) return flipped
  const { run: bookedRun, entryIds } = flipped.data

  // Utlägg repaid with this salary: mark the claims paid with a payout batch
  // that points at the salary verifikat (same batch mechanism as the bank
  // path, no second verifikat). The verifikat is posted and the run is
  // booked at this point, so a failure cannot roll anything back: it is
  // logged loudly and the idempotent RPC can be re-run by an operator. The
  // pre-check above makes the RPC's refusal codes unreachable in practice.
  if (rosterHasLinkedExpenseClaims(roster)) {
    const settled = await settleExpenseClaimsForBookedRun(supabase, { companyId, userId, salaryRunId })
    if (settled.ok) {
      log.info('expense claims settled via salary run', {
        salaryRunId,
        claimCount: settled.data.claim_count,
        alreadySettled: settled.data.already_settled,
        totalSek: settled.data.total_sek,
      })
    } else {
      log.error(
        'expense claims NOT settled after salary booking: run is booked with a 2820 debit but the claims are still open; re-run settle_expense_claims_via_salary_run',
        new Error(settled.detail ?? settled.code),
        { salaryRunId, companyId, code: settled.code },
      )
    }
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
 *   - missing or invalid bank details (for a positive net payout) and missing
 *     email are warnings, not blockers (dashboard force-approve semantics)
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
      const bankRemark =
        effectiveNetPayout(sre) > 0
          ? employeeBankDetailsRemark(name, emp.clearing_number, emp.bank_account_number)
          : null
      if (bankRemark) warnings.push(bankRemark)
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
