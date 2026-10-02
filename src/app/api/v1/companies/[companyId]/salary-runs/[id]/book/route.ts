/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/book
 *
 * The engine-touching verb. Mirrors the dashboard's `/book` route: loads the
 * run + employees + line items, calls `createSalaryRunEntries()` (which posts
 * 2-4 verifikationer via the bookkeeping engine), then UPDATEs status
 * `paid` → `booked` with the journal entry foreign keys.
 *
 * BFL 5 kap + 6 §§: the verifikation must reflect the actual cash movement
 * (payment_date). createSalaryRunEntries assigns voucher numbers atomically
 * via the `commit_journal_entry` RPC; immutability triggers prevent any
 * later edit.
 *
 * Booking claim (accounted#3251): the status precheck below is a read, so a
 * concurrent call passes it too. Before posting, the call claims the run in
 * the database (claimSalaryRunBooking, shared with the dashboard and MCP
 * doors); a concurrent call gets 409 SALARY_RUN_BOOKING_IN_PROGRESS and posts
 * nothing, and only the claim holder can flip the run to `booked`.
 *
 * Strict-mode v1: an engine throw aborts BEFORE the salary_runs status
 * mutation, and every verifikat passes the engine's checks before the first
 * one is numbered (createJournalEntries), so a refusal posts nothing: the run
 * remains in `paid` and the caller fixes the cause (e.g. unlock the period)
 * and retries. A posting that stops partway on a transient failure leaves the
 * vouchers posted so far; the retry adopts them instead of posting them twice,
 * and a posted voucher of the run that does not match is refused as
 * SALARY_RUN_PARTIALLY_BOOKED.
 *
 * Period-lock pre-check: we check `payment_date` against the company's lock
 * date and fiscal period status BEFORE invoking the engine, so the response
 * is a structured PERIOD_LOCKED rather than a generic engine error. The DB
 * trigger remains authoritative: this is ergonomics, not security.
 *
 * Audit block: the success response includes the salary verifikation's
 * voucher number + the entry IDs of all 2-4 posted entries, so an agent
 * can verify the audit trail in one round-trip.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  createSalaryRunEntries,
  SalaryRunPartiallyBookedError,
  salaryRunDataFromRows,
  type SalaryRosterRow,
  type SalaryRunRow,
} from '@/lib/salary/salary-entries'
import {
  assertLinkedExpenseClaimsOpen,
  rosterHasLinkedExpenseClaims,
  settleExpenseClaimsForBookedRun,
} from '@/lib/salary/expense-claim-lines'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'
import {
  claimSalaryRunBooking,
  markClaimedRunBooked,
  releaseSalaryRunBooking,
} from '@/lib/salary/book-run'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events'
import { refreshRunYtd } from '@/lib/salary/ytd'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const SalaryRunBooked = z.object({
  id: z.string().uuid(),
  status: z.literal('booked'),
  booked_at: z.string(),
  booked_by: z.string().uuid().nullable(),
  salary_entry_id: z.string().uuid(),
  avgifter_entry_id: z.string().uuid().nullable(),
  vacation_entry_id: z.string().uuid().nullable(),
  pension_entry_id: z.string().uuid().nullable(),
  entry_ids: z.array(z.string().uuid()),
})

const BOOK_RESPONSE_COLUMNS =
  'id, status, booked_at, booked_by, salary_entry_id, avgifter_entry_id, vacation_entry_id, pension_entry_id'

registerEndpoint({
  operation: 'salary-runs.book',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/book',
  summary: 'Post the verifikationer for a paid salary run.',
  description:
    'Creates 1-4 journal entries (1: salary brutto/tax/net; 2 if the run has any: arbetsgivaravgifter; 3 if applicable: semesterlöneskuld accrual; 4 if applicable: pension + SLP from löneväxling), then advances status `paid` → `booked` with all the entry IDs recorded on the salary_runs row. Strict-mode: any engine failure aborts BEFORE the status flip, and all entries are validated before the first is posted, so a refusal (locked period, missing BAS account, required or archived dimension value, etc.) posts nothing: the run stays in `paid` so the caller can fix the cause and retry.',
  useWhen:
    'You\'ve marked a salary run as paid and want to post the BFL-required verifikationer. This is the final lifecycle verb before AGI generation; after :book, the run can no longer be edited and corrections must use the (forthcoming) `:correct` verb.',
  doNotUseFor:
    'Posting salary entries outside the salary-run lifecycle (use POST /journal-entries directly). Re-booking an already-booked run (returns 400 SALARY_RUN_BOOK_NOT_PAID).',
  pitfalls: [
    'Run must be in `paid`: non-`paid` runs return 400 SALARY_RUN_BOOK_NOT_PAID.',
    'payment_date must fall in an open fiscal period: locked period returns 400 PERIOD_LOCKED with `fiscal_period_id` and a hint of what unlock action is needed.',
    'BFL 5 kap immutability: once `:book` succeeds the verifikationer cannot be edited or deleted. Corrections require `:correct` (Phase 5 PR-3) which does a storno-then-rebook.',
    'The salary verifikation is the primary one; its voucher_number appears in the response audit block. The avgifter, vacation, and pension entries get separate voucher numbers (returned as `entry_ids`).',
    'A run without arbetsgivaravgifter (only utlägg repaid, or only payees without avgifter such as F-skatt holders) posts no avgifter entry: avgifter_entry_id is null.',
    'Strict-mode: every entry is validated before the first is posted, so a refusal posts nothing and the run stays in `paid`. If posting stops partway on a transient failure, calling :book again adopts the entries already posted (when they match the run exactly) and posts only the missing ones, never twice. A posted entry of the run that does not match returns 409 SALARY_RUN_PARTIALLY_BOOKED with details.voucher_numbers: reverse those, then retry.',
    'One booking per run at a time: while another :book call (or a dashboard or MCP booking) for the same run is in flight, this call returns 409 SALARY_RUN_BOOKING_IN_PROGRESS and posts nothing. Do not retry at once after a client timeout: wait, GET the run, and call :book again only if it is still `paid`.',
  ],
  example: {
    response: {
      data: {
        id: 'run_a8f1…',
        status: 'booked',
        booked_at: '2026-05-26T09:15:00Z',
        booked_by: 'user_b73c…',
        salary_entry_id: 'je_salary…',
        avgifter_entry_id: 'je_avg…',
        vacation_entry_id: 'je_vac…',
        pension_entry_id: null,
        entry_ids: ['je_salary…', 'je_avg…', 'je_vac…'],
      },
      meta: {
        request_id: 'req_…',
        api_version: '2026-05-12',
        audit: {
          voucher_number: 'L2026-0023',
          voucher_url: '/api/v1/companies/.../journal-entries/je_salary…',
          immutable_at: '2026-05-26T09:15:00Z',
        },
      },
    },
  },
  scope: 'payroll:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(SalaryRunBooked) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.book',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }
    const salaryRunId = idParse.data

    // 1. Status precheck.
    const { data: run, error: fetchErr } = await ctx.supabase
      .from('salary_runs')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .maybeSingle()
    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!run) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((run as { status: string }).status !== 'paid') {
      return v1ErrorResponseFromCode('SALARY_RUN_BOOK_NOT_PAID', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (run as { status: string }).status },
      })
    }

    // 2. Period-lock pre-check. The DB trigger remains authoritative; this
    //    is so an agent gets a structured PERIOD_LOCKED response with
    //    fiscal_period_id rather than a generic engine error.
    const paymentDate = (run as { payment_date: string }).payment_date
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, paymentDate)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
          payment_date: paymentDate,
        },
      })
    }

    // 3. Load run + employees + line items for the engine.
    const { data: employees, error: empErr } = await ctx.supabase
      .from('salary_run_employees')
      .select('*, employee:employees(employment_type, default_dimensions, f_skatt_status), line_items:salary_line_items(*)')
      .eq('salary_run_id', salaryRunId)
    if (empErr) {
      return v1ErrorResponse(empErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!employees || employees.length === 0) {
      return v1ErrorResponseFromCode('SALARY_RUN_NO_EMPLOYEES', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Utlägg repaid with this salary (#2331): every linked claim must still
    // be open BEFORE anything is posted (mirrors lib/salary/book-run.ts).
    const claimsCheck = await assertLinkedExpenseClaimsOpen(
      ctx.supabase,
      ctx.companyId!,
      employees as Array<{ employee_id: string; line_items: Array<Record<string, unknown>> | null }>,
    )
    if (!claimsCheck.ok) {
      return v1ErrorResponseFromCode(claimsCheck.code, ctx.log, {
        requestId: ctx.requestId,
        details: claimsCheck.details,
      })
    }

    if (ctx.dryRun) {
      // Without invoking the engine we can't get real voucher numbers, but
      // we CAN preview the would-be state transition + the expected entry
      // shape (which entries will exist based on totals). Agents can use
      // this to detect missing employees / wrong totals before paying for
      // the real call.
      const totalVacation = (employees as Array<{ vacation_accrual: number }>).reduce(
        (sum, e) => sum + e.vacation_accrual,
        0,
      )
      const totalVacationAvgifter = (employees as Array<{ vacation_accrual_avgifter: number }>).reduce(
        (sum, e) => sum + e.vacation_accrual_avgifter,
        0,
      )
      return dryRunPreview(
        {
          id: salaryRunId,
          would_advance_status_from: 'paid',
          would_advance_status_to: 'booked',
          would_post_entries: [
            'salary (gross + tax withholding + net payment)',
            // Through the booking's own mapper (overrides, F-skatt rows), so
            // a run without avgifter previews no avgifter entry either.
            ...(salaryRunDataFromRows(run as SalaryRunRow, employees as SalaryRosterRow[]).employees.some(
              (employee) => Math.round(employee.avgifter_amount * 100) !== 0,
            )
              ? ['arbetsgivaravgifter']
              : []),
            ...(totalVacation > 0 || totalVacationAvgifter > 0 ? ['vacation accrual'] : []),
            ...((employees as Array<{ line_items: Array<{ item_type: string; amount: number }> | null }>).some(
              (employee) =>
                (employee.line_items || []).some(
                  (line) =>
                    line.item_type === 'gross_deduction_pension' &&
                    Math.round(Math.abs(line.amount) * 100) !== 0,
                ),
            )
              ? ['pension provision and SLP']
              : []),
          ],
          note: 'A live call validates all 2-4 verifikationer before posting the first (createSalaryRunEntries). Voucher numbers are assigned at commit time.',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // 4. Claim the run for this call. Exactly one of two concurrent calls
    //    gets the claim; the other posts nothing.
    const bookingClaim = await claimSalaryRunBooking(ctx.supabase, ctx.companyId!, salaryRunId)
    if (!bookingClaim.ok) {
      if (bookingClaim.reason === 'db_error') {
        return v1ErrorResponse(bookingClaim.dbError, ctx.log, { requestId: ctx.requestId })
      }
      if (bookingClaim.reason === 'in_progress') {
        return v1ErrorResponseFromCode('SALARY_RUN_BOOKING_IN_PROGRESS', ctx.log, { requestId: ctx.requestId })
      }
      if (bookingClaim.currentStatus === null) {
        return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode('SALARY_RUN_BOOK_NOT_PAID', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: bookingClaim.currentStatus },
      })
    }

    // A booking that does not reach `booked` hands the run back, so the
    // caller can retry at once instead of waiting out the claim's expiry.
    const releaseClaim = () =>
      releaseSalaryRunBooking(ctx.supabase, ctx.companyId!, salaryRunId, bookingClaim.claimId, ctx.log)

    // 5. Engine call. Strict-mode: any throw aborts before status flip.
    // Rows -> engine input through the one mapper every booking surface and
    // the journal preview share (salaryRunDataFromRows): review overrides,
    // the F-skatt avgifter rules and employee dimensions reach the ledger
    // identically no matter which surface books the run.
    let vouchers: Awaited<ReturnType<typeof createSalaryRunEntries>>
    try {
      vouchers = await createSalaryRunEntries(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        salaryRunDataFromRows(run as SalaryRunRow, employees as SalaryRosterRow[]),
      )
    } catch (err) {
      await releaseClaim()
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      if (err instanceof SalaryRunPartiallyBookedError) {
        return v1ErrorResponseFromCode(err.code, ctx.log, {
          requestId: ctx.requestId,
          details: err.details,
        })
      }
      ctx.log.error('salary booking failed', err as Error, {
        salaryRunId,
        companyId: ctx.companyId,
        userId: ctx.userId,
      })
      return v1ErrorResponseFromCode('SALARY_RUN_BOOK_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
    // The audit block needs only id + voucher_number of the primary salary
    // entry; the full JournalEntry shape is broader.
    const salaryEntry = vouchers.salaryEntry as unknown as { id: string; voucher_number: string }

    // 6. paid -> booked, only for the claim holder: status and claim token are
    //    filtered in the same UPDATE, which also clears the claim. A failure
    //    here comes after the engine committed; markClaimedRunBooked logs it
    //    with the entry ids, and a retry adopts the posted vouchers.
    const flipped = await markClaimedRunBooked(
      ctx.supabase,
      { companyId: ctx.companyId!, userId: ctx.userId, salaryRunId, log: ctx.log },
      bookingClaim.claimId,
      vouchers,
      BOOK_RESPONSE_COLUMNS,
    )
    if (!flipped.ok) {
      await releaseClaim()
      if (flipped.dbError) {
        return v1ErrorResponse(flipped.dbError, ctx.log, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode(flipped.code, ctx.log, {
        requestId: ctx.requestId,
        details: flipped.details,
      })
    }
    const { run: bookedRun, entryIds } = flipped.data

    // Utlägg repaid with this salary: mark the claims paid with a payout
    // batch pointing at the salary verifikat (mirrors lib/salary/book-run.ts;
    // the verifikat is posted, so a failure is logged, never rolled back).
    if (
      rosterHasLinkedExpenseClaims(
        employees as Array<{ employee_id: string; line_items: Array<Record<string, unknown>> | null }>,
      )
    ) {
      const settled = await settleExpenseClaimsForBookedRun(ctx.supabase, {
        companyId: ctx.companyId!,
        userId: ctx.userId,
        salaryRunId,
      })
      if (!settled.ok) {
        ctx.log.error(
          'expense claims NOT settled after salary booking: run is booked with a 2820 debit but the claims are still open; re-run settle_expense_claims_via_salary_run',
          new Error(settled.detail ?? settled.code),
          { salaryRunId, companyId: ctx.companyId, code: settled.code },
        )
      }
    }

    // Final refresh of the payslip's "Ackumulerat" snapshot, mirroring
    // lib/salary/book-run.ts. Non-fatal: YTD is display only and never
    // reaches a verifikation.
    const ytdRefresh = await refreshRunYtd(ctx.supabase, {
      companyId: ctx.companyId!,
      salaryRunId,
    })
    if (!ytdRefresh.ok) {
      ctx.log.warn('YTD refresh failed after booking', {
        salaryRunId,
        message: ytdRefresh.message,
      })
    }

    try {
      await eventBus.emit({
        type: 'salary_run.booked',
        payload: {
          salaryRunId,
          entryIds,
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (err) {
      ctx.log.warn('salary_run.booked emit failed', err as Error)
    }

    // Vacation ledger sync (non-fatal: the ledger recomputes and self-heals
    // on the next booking; a sync bug must never block a booking).
    const ledgerSync = await syncVacationLedgerForEmployees(
      ctx.supabase,
      ctx.companyId!,
      (employees as Array<{ employee_id: string }>).map((sre) => sre.employee_id),
    )
    if (!ledgerSync.ok) {
      ctx.log.warn('vacation ledger sync failed after booking', { message: ledgerSync.message })
    }

    const bookedAt = (bookedRun as { booked_at: string }).booked_at

    return ok(
      { ...bookedRun, entry_ids: entryIds },
      {
        requestId: ctx.requestId,
        audit: {
          voucher_number: salaryEntry.voucher_number,
          voucher_url: `/api/v1/companies/${ctx.companyId}/journal-entries/${salaryEntry.id}`,
          immutable_at: bookedAt,
        },
      },
    )
  },
)
