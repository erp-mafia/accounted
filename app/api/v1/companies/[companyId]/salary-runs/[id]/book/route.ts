/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/book
 *
 * The engine-touching verb. Mirrors the dashboard's `/book` route: loads the
 * run + employees + line items, calls `createSalaryRunEntries()` (which posts
 * 2-4 verifikationer via the bookkeeping engine), then optimistic-lock
 * UPDATEs status `paid` → `booked` with the journal entry foreign keys.
 *
 * BFL 5 kap + 6 §§: the verifikation must reflect the actual cash movement
 * (payment_date). createSalaryRunEntries assigns voucher numbers atomically
 * via the `commit_journal_entry` RPC; immutability triggers prevent any
 * later edit.
 *
 * Strict-mode v1: an engine throw aborts BEFORE the salary_runs status
 * mutation. There is no partial-state recovery banner; the caller sees a
 * clean error and the run remains in `paid` so they can fix the underlying
 * cause (e.g. unlock the period) and retry.
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
import { createSalaryRunEntries } from '@/lib/salary/salary-entries'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events'

const SalaryRunBooked = z.object({
  id: z.string().uuid(),
  status: z.literal('booked'),
  booked_at: z.string(),
  booked_by: z.string().uuid().nullable(),
  salary_entry_id: z.string().uuid(),
  avgifter_entry_id: z.string().uuid(),
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
    'Creates 2-4 journal entries (1: salary brutto/tax/net; 2: arbetsgivaravgifter; 3 if applicable: semesterlöneskuld accrual; 4 if applicable: pension + SLP from löneväxling), then advances status `paid` → `booked` with all the entry IDs recorded on the salary_runs row. Strict-mode: any engine failure aborts BEFORE the status flip: the run stays in `paid` so the caller can fix the cause (locked period, missing BAS account, etc.) and retry.',
  useWhen:
    'You\'ve marked a salary run as paid and want to post the BFL-required verifikationer. This is the final lifecycle verb before AGI generation; after :book, the run can no longer be edited and corrections must use the (forthcoming) `:correct` verb.',
  doNotUseFor:
    'Posting salary entries outside the salary-run lifecycle (use POST /journal-entries directly). Re-booking an already-booked run (returns 400 SALARY_RUN_BOOK_NOT_PAID).',
  pitfalls: [
    'Run must be in `paid`: non-`paid` runs return 400 SALARY_RUN_BOOK_NOT_PAID.',
    'payment_date must fall in an open fiscal period: locked period returns 400 PERIOD_LOCKED with `fiscal_period_id` and a hint of what unlock action is needed.',
    'BFL 5 kap immutability: once `:book` succeeds the verifikationer cannot be edited or deleted. Corrections require `:correct` (Phase 5 PR-3) which does a storno-then-rebook.',
    'The salary verifikation is the primary one; its voucher_number appears in the response audit block. The avgifter, vacation, and pension entries get separate voucher numbers (returned as `entry_ids`).',
    'Strict-mode: if the engine fails partway, the salary_runs row stays in `paid`. There is no "partial booking": the engine either commits all entries or the entire booking fails.',
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
      .select('*, employee:employees(employment_type, default_dimensions), line_items:salary_line_items(*)')
      .eq('salary_run_id', salaryRunId)
    if (empErr) {
      return v1ErrorResponse(empErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!employees || employees.length === 0) {
      return v1ErrorResponseFromCode('SALARY_RUN_NO_EMPLOYEES', ctx.log, {
        requestId: ctx.requestId,
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
            'arbetsgivaravgifter',
            ...(totalVacation > 0 || totalVacationAvgifter > 0 ? ['vacation accrual'] : []),
            // Pension cannot be detected without the engine: we'd need
            // to inspect line_items for löneväxling. Omitted from preview.
          ],
          note: 'A live call posts 2-4 verifikationer atomically via createSalaryRunEntries. Voucher numbers are assigned at commit time.',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // 4. Engine call. Strict-mode: any throw aborts before status flip.
    type EmpRow = {
      employee_id: string
      employee: { employment_type: string; default_dimensions?: Record<string, string> } | null
      gross_salary: number
      tax_withheld: number
      net_salary: number
      avgifter_amount: number
      avgifter_rate: number
      vacation_accrual: number
      vacation_accrual_avgifter: number
      line_items: Array<{
        item_type: string
        amount: number
        account_number: string | null
        is_net_deduction: boolean
        is_gross_deduction: boolean
      }> | null
    }
    let salaryEntry: { id: string; voucher_number: string }
    let avgifterEntry: { id: string }
    let vacationEntry: { id: string } | null
    let pensionEntry: { id: string } | null
    try {
      const result = await createSalaryRunEntries(ctx.supabase, ctx.companyId!, ctx.userId, {
        id: (run as { id: string }).id,
        period_year: (run as { period_year: number }).period_year,
        period_month: (run as { period_month: number }).period_month,
        payment_date: paymentDate,
        voucher_series: (run as { voucher_series: string }).voucher_series,
        total_gross: (run as { total_gross: number }).total_gross,
        total_tax: (run as { total_tax: number }).total_tax,
        total_net: (run as { total_net: number }).total_net,
        total_avgifter: (run as { total_avgifter: number }).total_avgifter,
        total_vacation_accrual: (run as { total_vacation_accrual: number }).total_vacation_accrual,
        employees: (employees as EmpRow[]).map((sre) => ({
          employee_id: sre.employee_id,
          employment_type: sre.employee?.employment_type || 'employee',
          gross_salary: sre.gross_salary,
          tax_withheld: sre.tax_withheld,
          net_salary: sre.net_salary,
          avgifter_amount: sre.avgifter_amount,
          avgifter_rate: sre.avgifter_rate,
          vacation_accrual: sre.vacation_accrual,
          vacation_accrual_avgifter: sre.vacation_accrual_avgifter,
          // Dimensions PR8: read-at-book from the employee row.
          default_dimensions: sre.employee?.default_dimensions ?? undefined,
          line_items: (sre.line_items || []).map((li) => ({
            item_type: li.item_type,
            amount: li.amount,
            account_number: li.account_number,
            is_net_deduction: li.is_net_deduction,
            is_gross_deduction: li.is_gross_deduction,
          })),
        })),
      })
      // Narrow to just the fields the route consumes: id + voucher_number
      // for the primary salary entry, id for the others. The full
      // JournalEntry shape is broader than what the audit block needs.
      salaryEntry = result.salaryEntry as unknown as { id: string; voucher_number: string }
      avgifterEntry = result.avgifterEntry
      vacationEntry = result.vacationEntry
      pensionEntry = result.pensionEntry
    } catch (err) {
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('salary booking failed', err as Error, {
        salaryRunId,
        companyId: ctx.companyId,
        userId: ctx.userId,
      })
      return v1ErrorResponseFromCode('SALARY_RUN_BOOK_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }

    // 5. Optimistic-lock the status flip on status='paid'. Concurrent calls
    //    would have re-posted JEs (a real bug: we'd have orphans), but
    //    the engine's atomicity makes that a no-op race that just won't
    //    commit the second status flip.
    const entryIds = [salaryEntry.id, avgifterEntry.id]
    const updates: Record<string, unknown> = {
      status: 'booked',
      salary_entry_id: salaryEntry.id,
      avgifter_entry_id: avgifterEntry.id,
      booked_at: new Date().toISOString(),
      booked_by: ctx.userId,
    }
    if (vacationEntry) {
      updates.vacation_entry_id = vacationEntry.id
      entryIds.push(vacationEntry.id)
    }
    if (pensionEntry) {
      updates.pension_entry_id = pensionEntry.id
      entryIds.push(pensionEntry.id)
    }

    const { data: bookedRun, error: updateError } = await ctx.supabase
      .from('salary_runs')
      .update(updates)
      .eq('company_id', ctx.companyId!)
      .eq('id', salaryRunId)
      .eq('status', 'paid')
      .select(BOOK_RESPONSE_COLUMNS)
      .maybeSingle()

    if (updateError) {
      // The engine already committed; the row update failed. This is a
      // partial-state we cannot recover automatically. Surface loudly so
      // an operator notices and runs a manual reconciliation (the
      // verifikationer exist and have voucher numbers; the salary_runs
      // row just doesn't point at them yet).
      ctx.log.error('salary_runs status flip failed after engine commit', updateError as Error, {
        salaryRunId,
        companyId: ctx.companyId,
        entryIds,
      })
      return v1ErrorResponse(updateError, ctx.log, { requestId: ctx.requestId })
    }
    if (!bookedRun) {
      // Race: the row's status changed between fetch and update. The
      // engine has committed; we cannot un-commit. Log loudly.
      ctx.log.error('salary_runs row missing after engine commit', new Error('race'), {
        salaryRunId,
        companyId: ctx.companyId,
        entryIds,
      })
      return v1ErrorResponseFromCode('SALARY_RUN_BOOK_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'row missing after engine commit', entry_ids: entryIds },
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

    const bookedAt = (bookedRun as { booked_at: string }).booked_at

    return ok(
      { ...(bookedRun as Record<string, unknown>), entry_ids: entryIds },
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
