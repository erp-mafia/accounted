/**
 * POST /api/v1/companies/{companyId}/salary-runs/{id}/payment-file
 *
 * Generates the salary payment file for a run so an external payroll
 * operator can pay the salaries without opening the app: ISO 20022 pain.001
 * XML (the format every Swedish bank accepts) or the legacy Bankgirot LB
 * text file. Mirrors the dashboard's GET /payment/pain001 and /payment/bg-lb
 * routes exactly: the loading, the preconditions and the
 * `payment_file_format` / `payment_file_generated_at` stamp all come from
 * the shared `buildSalaryPaymentFile()` in lib/salary/payment.
 *
 * Response shape: v1 JSON envelope with the file embedded as a string field
 * (`content`), like :generate-agi. Agents write `content` to `filename` and
 * upload it in the bank's corporate file channel. Nothing is sent to the
 * bank by this call and the run is NOT marked paid (that is :mark-paid).
 *
 * Idempotent at the call level (Idempotency-Key required) and harmless to
 * repeat: every call rebuilds the file from the run and re-stamps the
 * generated-at timestamp. Every live call also archives the exact file as an
 * immutable salary_payment_files row (BFL 7 kap. 1 §) before returning it;
 * `payment_file_id` and `sha256` identify that archived copy, and
 * GET /salary-runs/{id}/payment-files lists them. A dry run validates every
 * precondition, runs the pure generator so the preview is truthful, and
 * returns the preview without the content, without archiving and without
 * stamping.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1, type ApiV1Context } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import {
  buildSalaryPaymentFile,
  SALARY_PAYMENT_FILE_ALLOWED_STATUSES,
  SALARY_PAYMENT_FILE_FORMATS,
  type SalaryPaymentFileError,
} from '@/lib/salary/payment/build-payment-file'

const PaymentFileFormat = z.enum(SALARY_PAYMENT_FILE_FORMATS)

// `.strict()` on purpose: an execution date or any other unknown field must
// fail loudly. The file always uses the run's payment_date; silently ignoring
// a date an agent believes controls the transfer would be worse than a 400.
const PaymentFileRequest = z
  .object({
    format: PaymentFileFormat.optional(),
  })
  .strict()

const SalaryPaymentFile = z.object({
  salary_run_id: z.string().uuid(),
  /** Id of the archived copy (salary_payment_files); listable via GET /salary-runs/{id}/payment-files. */
  payment_file_id: z.string().uuid(),
  format: PaymentFileFormat,
  filename: z.string(),
  content_type: z.enum(['application/xml', 'text/plain']),
  content: z.string(),
  /** Lowercase hex SHA-256 over the file bytes as encoded for the bank (UTF-8 for pain001, ISO 8859-1 for bg_lb). */
  sha256: z.string(),
  payment_date: z.string(),
  employee_count: z.number().int(),
  total_amount: z.number(),
  currency: z.literal('SEK'),
  warnings: z.array(z.string()),
  generated_at: z.string(),
})

registerEndpoint({
  operation: 'salary-runs.payment-file',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary-runs/:id/payment-file',
  summary: 'Generate the bank payment file (pain.001 or Bankgirot LB) for a salary run.',
  description:
    'Builds the salary batch payment file for an approved (or paid / booked) run and returns it inline as a string: ISO 20022 pain.001.001.03 XML (`pain001`, default) or the legacy Bankgirot LB text file (`bg_lb`). One credit transfer per employee with a positive net payout, dated on the run\'s payment_date, category purpose SALA. Every generated file is archived as an immutable salary_payment_files row (BFL 7 kap. 1 §, seven-year retention) before it is returned; `payment_file_id` and `sha256` identify that copy and GET /salary-runs/{id}/payment-files lists them. Stamps salary_runs.payment_file_format and payment_file_generated_at. Same preconditions and output as the dashboard\'s payment-file download.',
  useWhen:
    'The salary run is approved and you (or an external payroll operator) need the file to upload in the bank\'s corporate file channel to pay the salaries.',
  doNotUseFor:
    'Marking the run paid (use :mark-paid after the bank has executed the batch), posting the verifikationer (use :book), paying supplier invoices (use the supplier-invoice payment batch), or sending anything to the bank: this call only produces the file.',
  pitfalls: [
    `Run status must be one of ${SALARY_PAYMENT_FILE_ALLOWED_STATUSES.join(', ')}: a draft or review run returns 409 SALARY_RUN_PAYMENT_FILE_NOT_READY. Approve the run first (:approve).`,
    'pain001 needs the company IBAN and a BIC (saved, or derived from the company clearing number / bank name) in company settings, plus clearing number and account number on every employee with a net payout. bg_lb needs a valid company bankgiro number. Missing company details return 422 SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS (details.problem names the field); missing employee accounts return 422 SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING with details.employees.',
    'The file comes back inline as `content` (a string). Write it to disk under `filename` (pain001 as UTF-8, bg_lb as ISO 8859-1 with CRLF line endings, exactly as returned) and upload it in the bank\'s file channel. Nothing is transmitted to the bank by this call.',
    'Generating the file does NOT mark the run paid and moves no money. Call :mark-paid once the bank has executed the batch, then :book to post the verifikationer.',
    'Bankgirot LB is being retired by the banks during 2026: prefer pain001. `format` defaults to company_settings.preferred_payment_format, which is pain001 unless the company changed it.',
    'Employees with a zero net payout (nollkörning, or net consumed by a nettolöneavdrag) are left out of the file and need no bank account; employee_count and total_amount cover only the paid lines. Regenerating is harmless: each call rebuilds the file, archives it as a new salary_payment_files row and re-stamps payment_file_generated_at.',
    'Every generated file is archived and listable: the response carries payment_file_id (the archived row) and sha256 (over the bytes as encoded for the bank: UTF-8 for pain001, ISO 8859-1 for bg_lb). Compare it with the checksum of what you uploaded, and use GET /salary-runs/{id}/payment-files to retrieve exactly what was generated earlier instead of regenerating: a regeneration after a bank-detail change (new employee account, changed company IBAN) is a different file, and the archive is the record of what the bank actually received. An archive failure returns an error and no file.',
    'The file always uses the run\'s payment_date as the requested execution date; the body accepts no execution date (unknown fields return 400). Change the run\'s payment_date (PATCH while draft) if the transfer day must move.',
    'Dry run (?dry_run=true) validates every precondition and returns format, filename, payment_date, employee_count, total_amount and warnings without the content, without archiving and without stamping the run.',
  ],
  example: {
    request: { format: 'pain001' },
    response: {
      data: {
        salary_run_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        payment_file_id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
        format: 'pain001',
        filename: 'pain001_lon_2026-05.xml',
        content_type: 'application/xml',
        content:
          '<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>…</CstmrCdtTrfInitn></Document>',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        payment_date: '2026-05-25',
        employee_count: 3,
        total_amount: 76500,
        currency: 'SEK',
        warnings: [],
        generated_at: '2026-05-20T08:00:00.000Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: PaymentFileRequest },
  response: { success: dataEnvelope(SalaryPaymentFile) },
})

/** Map the shared builder's outcome onto the structured-error catalogue. */
function paymentFileError(result: SalaryPaymentFileError, ctx: ApiV1Context) {
  const base = { requestId: ctx.requestId }
  switch (result.code) {
    case 'RUN_NOT_FOUND':
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, base)
    case 'RUN_NOT_READY':
      return v1ErrorResponseFromCode('SALARY_RUN_PAYMENT_FILE_NOT_READY', ctx.log, {
        ...base,
        details: result.details,
      })
    case 'COMPANY_NOT_FOUND':
      return v1ErrorResponseFromCode('COMPANY_NOT_FOUND', ctx.log, base)
    case 'SETTINGS_MISSING':
    case 'IBAN_MISSING':
    case 'BIC_MISSING':
    case 'BANKGIRO_MISSING':
    case 'BANKGIRO_INVALID':
      return v1ErrorResponseFromCode('SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS', ctx.log, {
        ...base,
        reason: result.code,
        details: { format: result.format, problem: result.code.toLowerCase(), ...result.details },
      })
    case 'NO_EMPLOYEES':
      return v1ErrorResponseFromCode('SALARY_RUN_NO_EMPLOYEES', ctx.log, base)
    case 'EMPLOYEE_BANK_MISSING':
      return v1ErrorResponseFromCode('SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING', ctx.log, {
        ...base,
        details: { format: result.format, ...result.details },
      })
    case 'GENERATOR_FAILED':
      return v1ErrorResponseFromCode('SALARY_RUN_PAYMENT_FILE_GENERATION_FAILED', ctx.log, {
        ...base,
        reason: String(result.details.message ?? ''),
        details: { format: result.format, ...result.details },
      })
    case 'ARCHIVE_FAILED':
      // The file is räkenskapsinformation and is never handed out
      // unarchived: the archive INSERT failure is the response.
      ctx.log.error('payment file archive failed; file withheld', {
        format: result.format,
        error: result.cause,
      })
      return v1ErrorResponse(result.cause, ctx.log, base)
    case 'DB_ERROR':
      return v1ErrorResponse(result.cause, ctx.log, base)
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.payment-file',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }
    const salaryRunId = idParse.data

    // The body is optional (format falls back to the company preference), but
    // a body that is present must be valid JSON: a malformed one is a caller
    // bug, not "no preference".
    let rawBody: unknown = {}
    const text = (await request.text()).trim()
    if (text.length > 0) {
      try {
        rawBody = JSON.parse(text)
      } catch {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: [{ field: 'body', message: 'Request body must be valid JSON.' }] },
        })
      }
    }
    const parsed = PaymentFileRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await buildSalaryPaymentFile(ctx.supabase, {
      companyId: ctx.companyId!,
      runId: salaryRunId,
      userId: ctx.userId,
      format: parsed.data.format,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) return paymentFileError(result, ctx)

    const summary = {
      salary_run_id: salaryRunId,
      format: result.format,
      filename: result.filename,
      content_type: result.contentType,
      payment_date: result.paymentDate,
      employee_count: result.employeeCount,
      total_amount: result.totalAmount,
      currency: 'SEK' as const,
      warnings: result.warnings,
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          ...summary,
          would_stamp: {
            payment_file_format: result.format,
            payment_file_generated_at: 'now (server time) on the live call',
          },
          note: 'Preconditions validated and the file built in memory; nothing was archived or stamped. The live call archives the file as a salary_payment_files row and returns it as `content`.',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    if (!result.stamped) {
      // The archived row is the record; the stamp is bookkeeping about the
      // run, so a failed UPDATE is logged, never fatal.
      ctx.log.warn('payment file stamp failed; file returned anyway', {
        salaryRunId,
        paymentFileId: result.paymentFileId,
        format: result.format,
      })
    }

    return ok(
      {
        ...summary,
        payment_file_id: result.paymentFileId,
        content: result.content,
        sha256: result.sha256,
        generated_at: result.generatedAt ?? new Date().toISOString(),
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
