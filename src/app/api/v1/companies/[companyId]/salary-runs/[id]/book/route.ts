/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/book
 *
 * The engine-touching verb, through the same service as the dashboard's
 * `/book` route (bookPaidSalaryRun in lib/salary/book-run.ts): loads the run
 * + employees + line items, posts 1-4 verifikationer via
 * `createSalaryRunEntries()` (or none for a nollkörning, a run without
 * amounts), then flips status `paid` → `booked` with the journal entry
 * foreign keys. The dry run is previewPaidSalaryRunBooking, which answers
 * after the same refusals.
 *
 * BFL 5 kap + 6 §§: the verifikation must reflect the actual cash movement
 * (payment_date). createSalaryRunEntries assigns voucher numbers atomically
 * via the `commit_journal_entry` RPC; immutability triggers prevent any
 * later edit.
 *
 * Booking claim (accounted#3251): the service claims the run in the database
 * before posting (claimSalaryRunBooking, shared with the dashboard and MCP
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
 * Period-lock pre-check: the service checks `payment_date` against the
 * company's lock date and fiscal period status BEFORE invoking the engine,
 * so the response is a structured PERIOD_LOCKED rather than a generic engine
 * error. The DB trigger remains authoritative: this is ergonomics, not
 * security.
 *
 * Payment date ahead (crm#1216): a run that pays out on a payment_date after
 * today needs { confirm_payment_date_ahead: true } in the optional body, the
 * same rule as the dashboard and MCP doors (lib/salary/payout-date.ts): the
 * salary verifikation credits the net pay to the bank account on that date.
 *
 * Audit block: the success response includes the salary verifikation's
 * voucher number + the entry IDs of all posted entries, so an agent can
 * verify the audit trail in one round-trip. A nollkörning has none.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1OptionalJsonBody } from '@/lib/api/v1/body'
import { SalaryRunPartiallyBookedError } from '@/lib/salary/salary-entries'
import { bookPaidSalaryRun, previewPaidSalaryRunBooking } from '@/lib/salary/book-run'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import type { Logger } from '@/lib/logger'

// Optional body. Unknown fields are ignored: the verb took no body before.
const BookRequest = z.object({
  confirm_payment_date_ahead: z.boolean().optional(),
})

const SalaryRunBooked = z.object({
  id: z.string().uuid(),
  status: z.literal('booked'),
  booked_at: z.string(),
  booked_by: z.string().uuid().nullable(),
  salary_entry_id: z.string().uuid().nullable(),
  avgifter_entry_id: z.string().uuid().nullable(),
  vacation_entry_id: z.string().uuid().nullable(),
  pension_entry_id: z.string().uuid().nullable(),
  entry_ids: z.array(z.string().uuid()),
})

const BOOK_RESPONSE_COLUMNS = [
  'id',
  'status',
  'booked_at',
  'booked_by',
  'salary_entry_id',
  'avgifter_entry_id',
  'vacation_entry_id',
  'pension_entry_id',
] as const

registerEndpoint({
  operation: 'salary-runs.book',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/book',
  summary: 'Post the verifikationer for a paid salary run.',
  description:
    'Creates 1-4 journal entries (1 if the run pays, withholds or expenses anything: salary brutto/tax/net, so a run whose only amount is a förmånsvärde has none and keeps salary_entry_id null; 2 if the run has any: arbetsgivaravgifter; 3 if applicable: semesterlöneskuld accrual; 4 if applicable: pension + SLP from löneväxling), then advances status `paid` → `booked` with all the entry IDs recorded on the salary_runs row. Strict-mode: any engine failure aborts BEFORE the status flip, and all entries are validated before the first is posted, so a refusal (locked period, missing BAS account, required or archived dimension value, etc.) posts nothing: the run stays in `paid` so the caller can fix the cause and retry. A nollkörning (a run without amounts, or without employees) posts no entries: it is booked with salary_entry_id null and no audit block, and the AGI nolldeklaration is the period\'s only artefact.',
  useWhen:
    'You\'ve marked a salary run as paid and want to post the BFL-required verifikationer. This is the final lifecycle verb before AGI generation; after :book, the run can no longer be edited and corrections must use the (forthcoming) `:correct` verb.',
  doNotUseFor:
    'Posting salary entries outside the salary-run lifecycle (use POST /journal-entries directly). Re-booking an already-booked run (returns 400 SALARY_RUN_BOOK_NOT_PAID).',
  pitfalls: [
    'Run must be in `paid`: non-`paid` runs return 400 SALARY_RUN_BOOK_NOT_PAID.',
    'payment_date must fall in an open fiscal period: locked period returns 400 PERIOD_LOCKED with `fiscal_period_id` and a hint of what unlock action is needed.',
    'A run that pays out with a payment_date after today (Swedish calendar day) returns 422 SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED (details.payment_date) unless the body has confirm_payment_date_ahead: true: the salary verifikation credits the net pay to the bank account on payment_date. Confirm only when the salaries have gone out or the payment is scheduled in the bank; otherwise book on or after payment_date.',
    'BFL 5 kap immutability: once `:book` succeeds the verifikationer cannot be edited or deleted. Corrections require `:correct` (Phase 5 PR-3) which does a storno-then-rebook.',
    'The salary verifikation is the primary one; its voucher_number appears in the response audit block. The avgifter, vacation, and pension entries get separate voucher numbers (returned as `entry_ids`).',
    'A run without arbetsgivaravgifter (only utlägg repaid, or only payees without avgifter such as F-skatt holders) posts no avgifter entry: avgifter_entry_id is null.',
    'A nollkörning (every total 0, or no employees) is booked without entries: entry_ids is [], salary_entry_id is null and meta.audit is absent. No period lock applies to it, since nothing is posted.',
    'Strict-mode: every entry is validated before the first is posted, so a refusal posts nothing and the run stays in `paid`. If posting stops partway on a transient failure, calling :book again adopts the entries already posted (when they match the run exactly) and posts only the missing ones, never twice. A posted entry of the run that does not match returns 409 SALARY_RUN_PARTIALLY_BOOKED with details.voucher_numbers: reverse those, then retry.',
    'One booking per run at a time: while another :book call (or a dashboard or MCP booking) for the same run is in flight, this call returns 409 SALARY_RUN_BOOKING_IN_PROGRESS and posts nothing. Do not retry at once after a client timeout: wait, GET the run, and call :book again only if it is still `paid`.',
  ],
  example: {
    request: { confirm_payment_date_ahead: true },
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
  request: { body: BookRequest },
  response: { success: dataEnvelope(SalaryRunBooked) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.book',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }
    const raw = await readV1OptionalJsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const body = BookRequest.safeParse(raw.body)
    if (!body.success) return v1ValidationError(ctx, body.error)

    const args = {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      salaryRunId: idParse.data,
      log: ctx.log,
      confirmPaymentDateAhead: body.data.confirm_payment_date_ahead,
    }

    if (ctx.dryRun) {
      const preview = await previewPaidSalaryRunBooking(ctx.supabase, args)
      if (!preview.ok) return refusal(preview, ctx)
      return dryRunPreview(preview.data, { requestId: ctx.requestId, log: ctx.log })
    }

    let result: Awaited<ReturnType<typeof bookPaidSalaryRun>>
    try {
      result = await bookPaidSalaryRun(ctx.supabase, args)
    } catch (err) {
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
        salaryRunId: args.salaryRunId,
        companyId: ctx.companyId,
        userId: ctx.userId,
      })
      return v1ErrorResponseFromCode('SALARY_RUN_BOOK_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
    if (!result.ok) return refusal(result, ctx)

    const bookedRun = result.data.run
    const data: Record<string, unknown> = {}
    for (const column of BOOK_RESPONSE_COLUMNS) data[column] = bookedRun[column] ?? null
    const salaryEntryId = bookedRun.salary_entry_id as string | null
    const voucherNumber = result.data.salaryVoucherNumber

    return ok(
      { ...data, entry_ids: result.data.entryIds },
      {
        requestId: ctx.requestId,
        ...(salaryEntryId && voucherNumber
          ? {
              audit: {
                voucher_number: voucherNumber,
                voucher_url: `/api/v1/companies/${ctx.companyId}/journal-entries/${salaryEntryId}`,
                immutable_at: bookedRun.booked_at as string,
              },
            }
          : {}),
      },
    )
  },
)

function refusal(
  result: { code: string; details?: Record<string, unknown>; dbError?: unknown },
  ctx: { requestId: string; log: Logger },
) {
  if (result.dbError) return v1ErrorResponse(result.dbError, ctx.log, { requestId: ctx.requestId })
  return v1ErrorResponseFromCode(result.code, ctx.log, {
    requestId: ctx.requestId,
    details: result.details,
  })
}
