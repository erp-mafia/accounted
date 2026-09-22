/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/correct
 *
 * The rättelsekörning for a booked run: the operator's way to fix a paid
 * month over the API. Mirrors the dashboard's `/correct` route through the
 * shared core in lib/salary/correct-run.ts:
 *
 *   1. storno every verifikation the run posted (BFL 5 kap 5 §: a posted
 *      entry is never edited or deleted, `reverseEntry` posts a reversing
 *      entry with its own voucher number),
 *   2. mark the original `corrected` and revoke its emailed payslip links,
 *   3. insert a fresh `draft` run for the same period with
 *      `is_correction = true` and `corrects_run_id`, roster and lines copied.
 *
 * The correction run then walks the normal lifecycle (edit lines, calculate,
 * approve, mark-paid, book, generate-agi). The AGI for the period must be
 * re-filed after the correction books.
 *
 * Bodyless POST. Idempotent (mandatory Idempotency-Key). Dry-runnable: the
 * preview reports the entries the live call would storno and the period the
 * correction run would take, without writing anything.
 *
 * No event: the dashboard route emits none either.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { correctSalaryRun } from '@/lib/salary/correct-run'

const CorrectionRun = z.object({
  id: z.string().uuid(),
  period_year: z.number().int(),
  period_month: z.number().int(),
  payment_date: z.string(),
  status: z.literal('draft'),
  is_correction: z.literal(true),
  corrects_run_id: z.string().uuid(),
  deviation_period_start: z.string().nullable(),
  deviation_period_end: z.string().nullable(),
})

const SalaryRunCorrected = z.object({
  original_run_id: z.string().uuid(),
  original_status: z.literal('corrected'),
  correction_run: CorrectionRun,
  reversed_entry_ids: z.array(z.string().uuid()),
})

registerEndpoint({
  operation: 'salary-runs.correct',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/correct',
  summary: 'Correct a booked salary run (rättelsekörning): storno its verifikat and open a new draft for the same period.',
  description:
    'Per Bokföringslagen 5 kap 5 § a booked salary run is never edited: this verb reverses every verifikation the run posted (salary, arbetsgivaravgifter, semesterlöneskuld, pension) with storno entries, marks the original `corrected`, revokes the payslip links that were emailed for it, and inserts a fresh `draft` run for the same period with `is_correction = true` and `corrects_run_id` pointing back. The roster and line items are copied onto the correction run so the operator edits a populated draft. Idempotent. Dry-runnable.',
  useWhen:
    'A booked (and usually paid) month turns out wrong: a missing line, a wrong salary, a benefit that was not on the payslip. Call this first, then edit the correction run\'s lines and walk it through calculate, approve, mark-paid, book and generate-agi.',
  doNotUseFor:
    'Runs that are not booked yet (draft, review, approved, paid): delete or edit them instead, nothing is posted. Fixing a single verifikation outside the salary lifecycle (POST /journal-entries/{id}/correct). Re-issuing payslips without changing amounts.',
  pitfalls: [
    'Only `booked` runs can be corrected: any other status returns 409 SALARY_RUN_CORRECT_NOT_BOOKED with `details.current_status`.',
    'The original\'s verifikat are reversed with storno (new reversing entries in the same series); nothing is edited or deleted. All reversed entry IDs are returned in `reversed_entry_ids`.',
    'The correction run is a fresh draft for the same period: it must be attached (roster is copied for you), calculated, approved, paid, booked and its AGI regenerated. Nothing is posted by this verb.',
    'A second call on the same run returns 409 SALARY_RUN_ALREADY_CORRECTED with `details.correction_run_id`: continue in that run instead.',
    'Payslip links of the original are revoked immediately (employees see "ersatt"); fresh links are issued when the correction run\'s payslips are sent.',
    'The arbetsgivardeklaration (AGI) for the period must be re-filed after the correction run books; Skatteverket receives the corrected figures, not a delta.',
    'The storno entries land in the original payment_date\'s period: a locked period returns PERIOD_LOCKED and nothing is written. If the failure happens after the first storno, `valid_alternatives.reversed_entry_ids` names the entries already reversed and `valid_alternatives.remaining_entry_ids` the ones still posted; the run stays `booked`; call this verb again once the cause is fixed: the retry skips the entries already reversed and continues with the remaining ones.',
    'Idempotency-Key is mandatory.',
  ],
  example: {
    response: {
      data: {
        original_run_id: 'run_a8f1…',
        original_status: 'corrected',
        correction_run: {
          id: 'run_c0rr…',
          period_year: 2026,
          period_month: 5,
          payment_date: '2026-05-25',
          status: 'draft',
          is_correction: true,
          corrects_run_id: 'run_a8f1…',
          deviation_period_start: '2026-04-01',
          deviation_period_end: '2026-04-30',
        },
        reversed_entry_ids: ['je_salary…', 'je_avg…', 'je_vac…'],
      },
      meta: {
        request_id: 'req_…',
        api_version: '2026-05-12',
      },
    },
  },
  scope: 'payroll:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: {
    success: dataEnvelope(SalaryRunCorrected),
    errorCodes: [
      'SALARY_RUN_NOT_FOUND',
      'SALARY_RUN_CORRECT_NOT_BOOKED',
      'SALARY_RUN_ALREADY_CORRECTED',
      'PERIOD_LOCKED',
      'CANNOT_REVERSE_NON_POSTED',
    ],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.correct',
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

    const result = await correctSalaryRun(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      runId: salaryRunId,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      switch (result.code) {
        case 'SALARY_RUN_NOT_FOUND':
          return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, {
            requestId: ctx.requestId,
          })
        case 'SALARY_RUN_CORRECT_NOT_BOOKED':
          return v1ErrorResponseFromCode('SALARY_RUN_CORRECT_NOT_BOOKED', ctx.log, {
            requestId: ctx.requestId,
            details: result.details,
          })
        case 'SALARY_RUN_ALREADY_CORRECTED':
          return v1ErrorResponseFromCode('SALARY_RUN_ALREADY_CORRECTED', ctx.log, {
            requestId: ctx.requestId,
            details: result.details,
          })
        case 'DB_ERROR':
          return v1ErrorResponse(result.error, ctx.log, {
            requestId: ctx.requestId,
            details: { stage: result.stage, salary_run_id: salaryRunId },
          })
        case 'REVERSAL_FAILED':
          // Usually a bookkeeping error (PERIOD_LOCKED, CANNOT_REVERSE_NON_POSTED):
          // v1ErrorResponse resolves the structured code and the canonical
          // `details` from the thrown value. The partial state (which stornos
          // are already live, which entries are still posted) is the agent's
          // next step, so it rides `valid_alternatives`.
          ctx.log.error('salary run correction: storno failed', result.error as Error, {
            salaryRunId,
            companyId: ctx.companyId,
            entryId: result.details.entry_id,
            reversedEntryIds: result.details.reversed_entry_ids,
          })
          return v1ErrorResponse(result.error, ctx.log, {
            requestId: ctx.requestId,
            details: { salary_run_id: salaryRunId, failed_entry_id: result.details.entry_id },
            validAlternatives: {
              salary_run_id: salaryRunId,
              failed_entry_id: result.details.entry_id,
              reversed_entry_ids: result.details.reversed_entry_ids,
              remaining_entry_ids: result.details.remaining_entry_ids,
              reverse_endpoint: `/api/v1/companies/${ctx.companyId}/journal-entries/{id}/reverse`,
            },
          })
      }
    }

    if (result.dryRun) {
      return dryRunPreview(
        {
          id: salaryRunId,
          would_advance_status_from: 'booked',
          would_advance_status_to: 'corrected',
          would_reverse_entry_ids: result.preview.entries_to_reverse,
          would_create_correction_run: result.preview.correction_run,
          original_run: result.preview.original_run,
          note: 'A live call posts one storno verifikation per entry in would_reverse_entry_ids, revokes the original payslip links and inserts the correction run as a draft with the roster copied. Nothing here is written.',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    for (const warning of result.warnings) {
      ctx.log.warn('salary run correction warning', { salaryRunId, message: warning })
    }

    const run = result.correctionRun
    return ok(
      {
        original_run_id: result.originalRunId,
        original_status: 'corrected',
        correction_run: {
          id: run.id,
          period_year: run.period_year,
          period_month: run.period_month,
          payment_date: run.payment_date,
          status: 'draft',
          is_correction: true,
          corrects_run_id: result.originalRunId,
          deviation_period_start: run.deviation_period_start ?? null,
          deviation_period_end: run.deviation_period_end ?? null,
        },
        reversed_entry_ids: result.reversedEntryIds,
      },
      {
        requestId: ctx.requestId,
        audit: {
          audit_trail_url: `/api/v1/companies/${ctx.companyId}/salary-runs/${salaryRunId}`,
          immutable_at: result.stampedAt,
        },
      },
    )
  },
  { requireIdempotencyKey: true },
)
