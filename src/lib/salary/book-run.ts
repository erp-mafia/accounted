/**
 * Shared salary-run booking orchestration.
 *
 * `bookPaidSalaryRun` is the booking core of the dashboard's
 * `POST /api/salary/runs/{id}/book` route and the v1 :book verb (whose dry
 * run is `previewPaidSalaryRunBooking`): load the paid run + roster, refuse
 * a payment date in a locked period with PERIOD_LOCKED before anything is
 * posted, handle the nollkörning branch (zero-amount runs post nothing: the
 * engine forbids zero vouchers), otherwise post 2-4 verifikationer via
 * `createSalaryRunEntries()`, advance `paid` → `booked`, emit
 * `salary_run.booked`, and sync the vacation ledger (non-fatal).
 * `createSalaryRunEntries()` posts all of the run's vouchers or none, and a
 * retry after an interrupted posting adopts what is already in the ledger
 * instead of posting it twice, so a run left `paid` is safe to book again.
 *
 * `advanceAndBookSalaryRun` is the pending-operation executor path for the
 * MCP tool `gnubok_book_salary_run`: the human approval of the staged
 * operation is the authorization act, so it walks a calculated run through
 * the remaining statuses (draft → review → approved → paid) with the
 * approval rules every door shares (validateRunForApproval in
 * lib/salary/approve-run.ts), then books. Missing bank details surface as
 * warnings rather than blockers (mirroring the dashboard's force-approve
 * path): the payment-file generators hard-block on them where it actually
 * matters. The walk holds only if the booking does: a booking that does not
 * complete hands the run back to the status it started from
 * (restoreWalkedRun), so a failed staged booking never leaves a run paid
 * with no verifikat, and the walk's salary_run.approved is announced only
 * once the run is booked.
 *
 * Both refuse a run that pays out on a payment date still ahead unless the
 * caller confirmed it (confirmPaymentDateAhead, paymentDateAheadRefusal in
 * lib/salary/payout-date.ts, crm#1216): the salary verifikat credits the
 * net pay to the bank account on that date.
 *
 * Bookkeeping-engine errors (period locks, unbalanced entries) and
 * SalaryRunPartiallyBookedError THROW out of both functions: callers map them
 * via their own envelope, exactly like the route did before extraction.
 * Every door takes the same booking claim and flips through the same
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
  buildSalaryRunEntryLines,
  createSalaryRunEntries,
  salaryRunDataFromRows,
  type SalaryRosterRow,
  type SalaryRunRow,
} from '@/lib/salary/salary-entries'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'
import { loadMonthAvgifterContext, type MonthContextRun } from '@/lib/salary/extra-runs'
import { runRemeasuresVacationLiability } from '@/lib/salary/vacation-liability-method'
import { refreshRunYtd } from '@/lib/salary/ytd'
import { validateRunForApproval, type ApprovalRosterRow } from '@/lib/salary/approve-run'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { paymentDateAheadRefusal } from '@/lib/salary/payout-date'
import { eventBus } from '@/lib/events'

export type BookRunResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; details?: Record<string, unknown>; dbError?: unknown }

export interface BookedRunData {
  run: Record<string, unknown>
  entryIds: string[]
  nollkorning: boolean
  /** The salary verifikat's voucher number; null for a nollkörning. */
  salaryVoucherNumber: string | null
}

export interface BookRunArgs {
  companyId: string
  userId: string
  salaryRunId: string
  log: Logger
  /**
   * The caller confirmed posting a payout whose payment date has not come
   * yet (the run page's Bokför dialog, confirm_payment_date_ahead on v1 and
   * MCP). Without it such a run is refused before anything moves.
   */
  confirmPaymentDateAhead?: boolean
}

const ROSTER_SELECT =
  '*, employee:employees(first_name, last_name, employment_type, personnel_category, default_dimensions, f_skatt_status, clearing_number, bank_account_number, email)'

type RosterRow = SalaryRosterRow & Record<string, unknown> & {
  tax_withheld_override: number | null
  employee: {
    first_name: string
    last_name: string
    employment_type: string | null
    personnel_category: string | null
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
  salaryEntry: { id: string } | null
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
    // No salary voucher for a run whose only amounts are a förmånsvärde and
    // its avgifter (crm#1596): nothing is paid, withheld or expensed.
    if (vouchers.salaryEntry) {
      updates.salary_entry_id = vouchers.salaryEntry.id
      entryIds.push(vouchers.salaryEntry.id)
    }
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

/**
 * Nollkörning: a run with no monetary effect (employees set to 0 kr, or no
 * roster at all) has nothing to post. The bookkeeping engine forbids
 * zero-amount vouchers (every entry must balance with debit & credit > 0),
 * so such a run is booked without journal entries; the AGI nolldeklaration
 * is then the only artefact for the period. The net is part of the test: a
 * run that only repays utlägg has gross 0 but a payout, and its 2820 D /
 * 1930 K must be posted.
 */
export function isNollkorning(run: Record<string, unknown>): boolean {
  return (
    Math.round(((run.total_gross as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_tax as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_net as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_avgifter as number) ?? 0) * 100) === 0 &&
    Math.round(((run.total_vacation_accrual as number) ?? 0) * 100) === 0
  )
}

/**
 * PERIOD_LOCKED before anything moves when the payment date, the date every
 * verifikat of the run carries, is in a closed or locked period or behind
 * the company lock date. The database triggers stay authoritative; this
 * answers with the period instead of an engine error, and before the MCP
 * walk has advanced the run's status. A nollkörning posts nothing, so no
 * period stands in its way.
 */
async function bookingPeriodRefusal(
  supabase: SupabaseClient,
  companyId: string,
  run: Record<string, unknown>,
): Promise<BookRunResult<never> | null> {
  if (isNollkorning(run)) return null
  const paymentDate = run.payment_date as string
  const verdict = await checkPeriodLock(supabase, companyId, paymentDate)
  if (!verdict.locked) return null
  return {
    ok: false,
    code: 'PERIOD_LOCKED',
    details: {
      reason: verdict.reason,
      fiscal_period_id: verdict.fiscal_period_id,
      payment_date: paymentDate,
    },
  }
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

/**
 * Runs after the flip to 'booked' and before salary_run.booked is emitted:
 * the MCP walk announces its approval here, once the run it approved is
 * booked.
 */
type OnBooked = () => Promise<void>

async function bookLoadedRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
  run: Record<string, unknown>,
  roster: RosterRow[],
  onBooked?: OnBooked,
): Promise<BookRunResult<BookedRunData>> {
  // Claim first: before the YTD refresh, the utlägg check, the nollkörning
  // branch and the posting, so a concurrent call for the same run posts
  // nothing and does no side work.
  const bookingClaim = await claimSalaryRunBooking(supabase, args.companyId, args.salaryRunId)
  if (!bookingClaim.ok) return bookingClaimRefusal(bookingClaim)

  let result: BookRunResult<BookedRunData> | undefined
  try {
    result = await bookClaimedRun(supabase, args, bookingClaim.claimId, run, roster, onBooked)
    return result
  } finally {
    // A booked run's flip already cleared the claim; anything else hands the
    // run back so a retry can start at once (and adopts what was posted).
    if (!result?.ok) {
      await releaseSalaryRunBooking(supabase, args.companyId, args.salaryRunId, bookingClaim.claimId, args.log)
    }
  }
}

/**
 * Stamp every roster row with the personnel category this booking posts with
 * (the employee's live personnel_category, the value salaryRunDataFromRows
 * resolves the wage accounts from), before anything is posted. The stamp is
 * what the Lönejournal shows for a booked run, so a later change of the
 * employee's category never rewrites a booked run. A failed stamp stops the
 * booking here, where nothing has been posted yet.
 */
async function stampPersonnelCategories(
  supabase: SupabaseClient,
  companyId: string,
  roster: RosterRow[],
): Promise<BookRunResult<null>> {
  const idsByCategory = new Map<string, string[]>()
  for (const sre of roster) {
    const category = sre.employee?.personnel_category ?? 'tjansteman'
    idsByCategory.set(category, [...(idsByCategory.get(category) ?? []), sre.id as string])
  }
  for (const [category, ids] of idsByCategory) {
    const { error } = await supabase
      .from('salary_run_employees')
      .update({ personnel_category: category })
      .in('id', ids)
      .eq('company_id', companyId)
    if (error) return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: error }
  }
  return { ok: true, data: null }
}

async function bookClaimedRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
  claimId: string,
  run: Record<string, unknown>,
  roster: RosterRow[],
  onBooked?: OnBooked,
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

  const stamped = await stampPersonnelCategories(supabase, companyId, roster)
  if (!stamped.ok) return stamped

  // Nollkörning (isNollkorning): nothing to post, so skip journal-entry
  // creation entirely and just advance to 'booked'.
  if (isNollkorning(run)) {
    const flipped = await markClaimedRunBooked(supabase, args, claimId, null)
    if (!flipped.ok) return flipped
    await onBooked?.()

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
    return {
      ok: true,
      data: { run: flipped.data.run, entryIds: [], nollkorning: true, salaryVoucherNumber: null },
    }
  }

  // Rows -> engine input through the same mapper the journal preview route
  // uses (overrides, F-skatt avgifter rules, dimensions all live there), so
  // the voucher the user approved on screen is the voucher that posts.
  const runData = salaryRunDataFromRows(run as unknown as SalaryRunRow, roster)
  // A month with several runs: 2731 takes this run's share of the month's
  // declared avgift (loadMonthAvgifterContext). Unread, nothing is posted.
  const month = await loadMonthAvgifterContext(supabase, companyId, run as unknown as MonthContextRun)
  if (!month.ok) return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: month.error }
  if (month.context) runData.month_avgifter = month.context
  const vouchers = await createSalaryRunEntries(supabase, companyId, userId, runData)

  const flipped = await markClaimedRunBooked(supabase, args, claimId, vouchers)
  if (!flipped.ok) return flipped
  const { run: bookedRun, entryIds } = flipped.data
  await onBooked?.()

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

  const voucherNumber = (vouchers.salaryEntry as { voucher_number?: string | number | null } | null)?.voucher_number
  return {
    ok: true,
    data: {
      run: bookedRun,
      entryIds,
      nollkorning: false,
      salaryVoucherNumber: voucherNumber == null ? null : String(voucherNumber),
    },
  }
}

interface PaidRunForBooking {
  run: Record<string, unknown>
  roster: RosterRow[]
}

/**
 * The paid run and its roster, or why it cannot be booked: not found, not
 * paid, or a payment date in a locked period. One read for every door that
 * books a paid run, so they refuse alike.
 */
async function loadPaidRunForBooking(
  supabase: SupabaseClient,
  args: BookRunArgs,
): Promise<BookRunResult<PaidRunForBooking>> {
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', args.salaryRunId)
    .eq('company_id', args.companyId)
    .maybeSingle()
  if (runError) return { ok: false, code: 'SALARY_RUN_BOOK_FAILED', dbError: runError }
  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  const status = (run as { status: string }).status
  if (status !== 'paid') {
    return { ok: false, code: 'SALARY_RUN_BOOK_NOT_PAID', details: { current_status: status } }
  }

  const ahead = paymentDateAheadRefusal(run, args.confirmPaymentDateAhead)
  if (ahead) return ahead

  const periodRefusal = await bookingPeriodRefusal(supabase, args.companyId, run)
  if (periodRefusal) return periodRefusal

  const roster = await loadRoster(supabase, args.salaryRunId)
  if (!roster.ok) return roster
  return { ok: true, data: { run, roster: roster.data } }
}

/**
 * paid → booked: the dashboard book route and the v1 :book verb. The run
 * must already be in 'paid' status.
 */
export async function bookPaidSalaryRun(
  supabase: SupabaseClient,
  args: BookRunArgs,
): Promise<BookRunResult<BookedRunData>> {
  const loaded = await loadPaidRunForBooking(supabase, args)
  if (!loaded.ok) return loaded
  return bookLoadedRun(supabase, args, loaded.data.run, loaded.data.roster)
}

export interface SalaryRunBookingPreview {
  id: string
  would_advance_status_from: 'paid'
  would_advance_status_to: 'booked'
  nollkorning: boolean
  would_post_entries: string[]
  note: string
}

/**
 * What bookPaidSalaryRun would do, after the same refusals, without claiming
 * the run or posting: the v1 dry run. Which verifikationer exist follows the
 * booking's own mapper (overrides, F-skatt rows), so a run without avgifter
 * previews no avgifter entry and a nollkörning previews none at all.
 */
export async function previewPaidSalaryRunBooking(
  supabase: SupabaseClient,
  args: BookRunArgs,
): Promise<BookRunResult<SalaryRunBookingPreview>> {
  const loaded = await loadPaidRunForBooking(supabase, args)
  if (!loaded.ok) return loaded
  const { run, roster } = loaded.data

  const claimsCheck = await assertLinkedExpenseClaimsOpen(supabase, args.companyId, roster)
  if (!claimsCheck.ok) return { ok: false, code: claimsCheck.code, details: claimsCheck.details }

  const base = {
    id: args.salaryRunId,
    would_advance_status_from: 'paid' as const,
    would_advance_status_to: 'booked' as const,
  }
  if (isNollkorning(run)) {
    return {
      ok: true,
      data: {
        ...base,
        nollkorning: true,
        would_post_entries: [],
        note: 'Nollkörning: the run has no amounts, so it is booked without journal entries; the AGI nolldeklaration is the only artefact for the period.',
      },
    }
  }

  const engineInput = salaryRunDataFromRows(run as unknown as SalaryRunRow, roster)
  const totalVacation = roster.reduce((sum, e) => sum + ((e.vacation_accrual as number) ?? 0), 0)
  const totalVacationAvgifter = roster.reduce(
    (sum, e) => sum + ((e.vacation_accrual_avgifter as number) ?? 0),
    0,
  )
  return {
    ok: true,
    data: {
      ...base,
      nollkorning: false,
      would_post_entries: [
        // The booking's own line builder decides, so a run whose only amount
        // is a förmånsvärde previews no salary voucher (crm#1596). The
        // description and bank account name lines, they never add or drop one.
        ...(buildSalaryRunEntryLines(engineInput, '', '').salaryLines.length > 0
          ? ['salary (gross + tax withholding + net payment)']
          : []),
        ...(engineInput.employees.some((employee) => Math.round(employee.avgifter_amount * 100) !== 0)
          ? ['arbetsgivaravgifter']
          : []),
        ...(runRemeasuresVacationLiability(run.calculation_params as Record<string, unknown> | null)
          ? ['vacation liability remeasurement (semesterlöneskuld: computed at booking, as of the payment date)']
          : totalVacation > 0 || totalVacationAvgifter > 0
            ? ['vacation accrual']
            : []),
        ...(roster.some((employee) =>
          (employee.line_items || []).some(
            (line) =>
              line.item_type === 'gross_deduction_pension' &&
              Math.round(Math.abs(line.amount as number) * 100) !== 0,
          ),
        )
          ? ['pension provision and SLP']
          : []),
      ],
      note: 'A live call validates all 1-4 verifikationer before posting the first (createSalaryRunEntries). Voucher numbers are assigned at commit time.',
    },
  }
}

export interface AdvanceAndBookData extends BookedRunData {
  warnings: string[]
}

/**
 * Walk a calculated salary run through review → approved → paid → booked.
 *
 * Used by the `book_salary_run` pending-operation executor: the staged
 * operation's human approval covers the authorization the dashboard collects
 * per-status. The approval rules are validateRunForApproval's, the ones
 * every door applies:
 *   - a draft never calculated, or a roster row without a
 *     calculation_breakdown, is blocking
 *   - missing or invalid bank details (for a positive net payout), missing
 *     email and F-skatt not verified are warnings, not blockers (dashboard
 *     force-approve semantics)
 * A payment date in a locked period, or one still ahead without
 * confirmPaymentDateAhead, is refused before any status moves.
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
  const startStatus = status
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
    // The approval rules every door shares (lib/salary/approve-run.ts). A
    // blocking problem would post a wrong verifikat; bank details and the
    // rest are warnings here, because the approval of the staged operation
    // is the user's "Godkänn ändå" (the payment-file step refuses them).
    const verdict = validateRunForApproval(roster as unknown as ApprovalRosterRow[], run)
    if (verdict.blocking.length > 0) {
      return {
        ok: false,
        code: 'SALARY_RUN_NOT_CALCULATED',
        details: { employees: verdict.uncalculated },
      }
    }
    warnings.push(...verdict.bankDetails, ...verdict.warnings)
  }

  // Before any status moves: a payment date in a locked period, or an
  // unconfirmed one still ahead, would leave the run walked to paid with
  // nothing booked.
  const ahead = paymentDateAheadRefusal(run, args.confirmPaymentDateAhead)
  if (ahead) return ahead
  const periodRefusal = await bookingPeriodRefusal(supabase, companyId, run)
  if (periodRefusal) return periodRefusal

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

  // The approval is announced once the run it approved is booked (onBooked):
  // a booking that fails hands the run back below, and an approval event for
  // a run back in review would be false.
  const announceApproval: OnBooked | undefined =
    startStatus === 'draft' || startStatus === 'review'
      ? async () => {
          try {
            await eventBus.emit({
              type: 'salary_run.approved',
              payload: { salaryRunId, approvedBy: userId, userId, companyId },
            })
          } catch (err) {
            args.log.warn('salary_run.approved emit failed', {
              salaryRunId,
              message: err instanceof Error ? err.message : String(err),
            })
          }
        }
      : undefined

  let booked: BookRunResult<BookedRunData>
  try {
    booked = await bookLoadedRun(supabase, args, run, roster, announceApproval)
  } catch (err) {
    await restoreWalkedRun(supabase, args, run, startStatus)
    throw err
  }
  if (!booked.ok) {
    await restoreWalkedRun(supabase, args, run, startStatus)
    return booked
  }
  return { ok: true, data: { ...booked.data, warnings } }
}

/**
 * Undo this call's own status walk when its booking did not complete. The
 * staged operation asked for a booked run, so a refusal or an engine error
 * puts the run back in the status the approval found it in, instead of
 * leaving it paid with no verifikat (agent feedback 2026-11-02: four
 * benefit-only runs walked to paid while the engine refused their voucher;
 * the booking succeeding is what makes the run paid here, not a payout).
 *
 * Only while the ledger holds nothing of the run: a run with a posted voucher
 * stays paid, where it cannot be unapproved and the next booking adopts the
 * voucher. The update is conditional on paid and unclaimed, so it never
 * undoes a concurrent booking. Never throws: a run that stays paid is still
 * booked with Bokför on the run page or another staged booking.
 */
async function restoreWalkedRun(
  supabase: SupabaseClient,
  { companyId, salaryRunId, log }: BookRunArgs,
  run: Record<string, unknown>,
  startStatus: string,
): Promise<void> {
  if (startStatus === 'paid') return
  try {
    const { data: posted, error: postedError } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .eq('source_type', 'salary_payment')
      .eq('source_id', salaryRunId)
      .in('status', ['posted', 'reversed'])
      .limit(1)
    if (postedError || (posted ?? []).length > 0) {
      log.warn('salary run left paid after a failed booking', {
        salaryRunId,
        reason: postedError ? 'ledger read failed' : 'the run has posted vouchers',
      })
      return
    }

    const restore: Record<string, unknown> = { status: startStatus, paid_at: run.paid_at ?? null }
    if (startStatus === 'draft' || startStatus === 'review') {
      restore.approved_by = run.approved_by ?? null
      restore.approved_at = run.approved_at ?? null
    }
    const { error } = await supabase
      .from('salary_runs')
      .update(restore)
      .eq('id', salaryRunId)
      .eq('company_id', companyId)
      .eq('status', 'paid')
      .is('booking_claim_id', null)
    if (error) {
      log.warn('salary run left paid after a failed booking', { salaryRunId, message: error.message })
    }
  } catch (err) {
    log.warn('salary run left paid after a failed booking', {
      salaryRunId,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
