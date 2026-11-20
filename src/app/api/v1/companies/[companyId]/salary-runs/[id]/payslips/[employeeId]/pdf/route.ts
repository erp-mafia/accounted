/**
 * GET /api/v1/companies/{companyId}/salary-runs/{id}/payslips/{employeeId}/pdf
 *
 * Render one employee's payslip as application/pdf. Byte-equivalent to the
 * dashboard download: data assembly is shared via
 * lib/salary/payslips/build-payslip-data, and ?audience= means the same as
 * on the dashboard route (absent: the employer view with every section;
 * employee: the copy the employee receives, which follows the company's
 * payslip section switches).
 *
 * Per BFL: payslips are räkenskapsinformation linked to posted journal
 * entries (7-year retention). Read-only: no Idempotency-Key, no dry-run.
 *
 * The one write this read can cause is issuing the run's payslip sections
 * (section-snapshot), which the database then keeps forever. A read must
 * never cause a permanent write, so only a caller that may write the payroll
 * issues: a key holding payroll:write, on a company it may write (not a
 * viewer membership, not a read-only connection), outside dry run and test
 * mode. Any other caller gets the employee copy from the run's stored
 * snapshot when it has one, else from the live switches, and nothing is
 * written.
 */

import { z } from 'zod'
import { loadPayslip, preparePayslip, renderPayslipPdf } from '@/lib/salary/payslips/load-payslip'
import { contentDisposition } from '@/lib/api/content-disposition'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { hasScope } from '@/lib/auth/api-keys'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const PayslipPdfQuery = z.object({
  audience: z
    .enum(['employer', 'employee'])
    .optional()
    .describe(
      'employer (default): every section, the employer\'s own view. employee: the copy the employee receives; Arbetsgivarkostnad and Beräkningsunderlag follow salary_payslip_show_employer_cost / salary_payslip_show_breakdown (GET /salary/settings).',
    ),
})

registerEndpoint({
  operation: 'salary-runs.payslip.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs/:id/payslips/:employeeId/pdf',
  summary: 'Download one employee\'s payslip as PDF.',
  description:
    'Returns the rendered payslip (lönespecifikation) as application/pdf, byte-equivalent to the dashboard download. Content-Disposition is attachment with a filename derived from the period and employee name.',
  useWhen:
    'You need the payslip document itself: archiving, forwarding to the employee outside the Accounted send flow (pass audience=employee), or attaching to an external HR system.',
  doNotUseFor:
    'The payslip DATA (amounts, line items): use GET /salary-runs/{id}/employees/{employeeId}, which is cheaper and structured. Emailing payslips to employees: POST /salary-runs/{id}/send-payslips sends each a secure link.',
  pitfalls: [
    'The PDF renders whatever the run currently holds: for a draft run that has not been calculated, amounts are 0.',
    'PDF rendering takes a few hundred milliseconds; cache on the client if requesting repeatedly.',
    'Without audience the PDF is the employer view and always prints Arbetsgivarkostnad and Beräkningsunderlag. A PDF you forward to the employee should use audience=employee, so it matches the emailed payslip link and honours the company\'s section switches.',
    'audience=employee on an approved, paid or booked run, from a key that also holds payroll:write on a company it may write, issues the payslip: the first employee copy of the run (or the payslip email, whichever comes first) fixes which sections it prints, and every later employee copy of that run prints the same sections even after the company changes its switches. A key with only payroll:read (or a read-only membership or connection) never fixes anything: it gets the sections the run was issued with, or the current switches while the run is not issued yet. On a draft or review run the employee copy follows the current switches and fixes nothing.',
  ],
  example: {
    response: {
      _note: 'Returns application/pdf binary stream.',
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: PayslipPdfQuery },
  response: {
    success: z.unknown(), // Marker: binary response, see contentType.
    contentType: 'application/pdf',
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string; employeeId: string }> }>(
  'salary-runs.payslip.pdf',
  async (request, ctx, params) => {
    const { id, employeeId } = await params.params
    const runParse = z.string().uuid().safeParse(id)
    const empParse = z.string().uuid().safeParse(employeeId)
    if (!runParse.success || !empParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: runParse.success ? 'employeeId' : 'id',
          message: 'Path ids must be UUIDs.',
        },
      })
    }
    const audienceParam = new URL(request.url).searchParams.get('audience')
    const queryParse = PayslipPdfQuery.safeParse({ audience: audienceParam ?? undefined })
    if (!queryParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'audience', message: 'audience must be employer or employee.' },
      })
    }

    // Loading, the audience and the PDF are the one payslip render path
    // (lib/salary/payslips/load-payslip.ts), shared with the dashboard and
    // the token link.
    const loaded = await loadPayslip(ctx.supabase, {
      companyId: ctx.companyId!,
      salaryRunId: runParse.data,
      employeeId: empParse.data,
    })
    if (!loaded.ok) {
      if (loaded.reason === 'db_error') return v1ErrorResponse(loaded.error, ctx.log, { requestId: ctx.requestId })
      if (loaded.reason === 'run_not_found') {
        return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details:
          loaded.reason === 'employee_not_found'
            ? { resource: 'salary_run_employee', employee_id: empParse.data }
            : { resource: 'company' },
      })
    }

    // Only a payroll writer hands the copy out and fixes its sections on the
    // run; a read-only caller renders from the run as stored (its snapshot
    // when issued, else the switches) and writes nothing. A test key is
    // simulation-only and a dry run persists nothing.
    const mayIssue =
      hasScope(ctx.scopes, 'payroll:write') && ctx.companyWritable && ctx.mode === 'live' && !ctx.dryRun
    const prepared = await preparePayslip(ctx.supabase, loaded.payslip, {
      companyId: ctx.companyId!,
      audience: queryParse.data.audience ?? 'employer',
      mayIssue,
    })
    if (!prepared.ok) return v1ErrorResponse(prepared.error, ctx.log, { requestId: ctx.requestId })

    let pdfBuffer: Buffer
    const fileName = prepared.fileName
    try {
      pdfBuffer = await renderPayslipPdf(prepared.data)
    } catch (err) {
      ctx.log.error('salary-runs.payslip.pdf: render failed', err as Error, {
        salaryRunId: runParse.data,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
    }

    const uint8Array = new Uint8Array(pdfBuffer)
    return new Response(uint8Array, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // RFC 5987 dual form: employee names with non-Latin-1 characters
        // would otherwise make undici reject the header value.
        'Content-Disposition': contentDisposition('attachment', fileName),
        'Content-Length': String(pdfBuffer.length),
        'X-Request-Id': ctx.requestId,
      },
    })
  },
)
