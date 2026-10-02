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
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import {
  buildPayslipData,
  payslipFileName,
  type PayslipAudience,
} from '@/lib/salary/payslips/build-payslip-data'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'
import { contentDisposition } from '@/lib/api/content-disposition'
import { getCompanyDisplayName } from '@/lib/company/context'
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

    const { data: run, error: runErr } = await ctx.supabase
      .from('salary_runs')
      .select('*')
      .eq('id', runParse.data)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (runErr) {
      return v1ErrorResponse(runErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!run) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const { data: sre, error: sreErr } = await ctx.supabase
      .from('salary_run_employees')
      .select(
        '*, employee:employees(first_name, last_name, personnummer, personnummer_last4, employment_type, tax_table_number, tax_column, clearing_number, bank_account_number), line_items:salary_line_items(*)',
      )
      .eq('salary_run_id', runParse.data)
      .eq('employee_id', empParse.data)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (sreErr) {
      return v1ErrorResponse(sreErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!sre) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'salary_run_employee', employee_id: empParse.data },
      })
    }

    const { data: company, error: companyErr } = await ctx.supabase
      .from('companies')
      .select('name, org_number')
      .eq('id', ctx.companyId!)
      .maybeSingle()
    if (companyErr || !company) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'company' },
      })
    }

    const emp = sre.employee as {
      first_name: string; last_name: string; personnummer: string; personnummer_last4: string;
      employment_type: string; tax_table_number: number | null; tax_column: number;
      clearing_number: string | null; bank_account_number: string | null;
    }

    let audience: PayslipAudience = { kind: 'employer' }
    let renderRun = run
    if (queryParse.data.audience === 'employee') {
      const { data: sectionSettings, error: settingsErr } = await ctx.supabase
        .from('company_settings')
        .select('salary_payslip_show_employer_cost, salary_payslip_show_breakdown')
        .eq('company_id', ctx.companyId!)
        .maybeSingle()
      if (settingsErr) {
        return v1ErrorResponse(settingsErr, ctx.log, { requestId: ctx.requestId })
      }
      audience = { kind: 'employee', settings: sectionSettings }
      // Only a payroll writer hands the copy out and fixes its sections on
      // the run; a read-only caller renders from the run as stored (its
      // snapshot when issued, else the switches) and writes nothing.
      // A test key is simulation-only and a dry run persists nothing.
      const mayIssue =
        hasScope(ctx.scopes, 'payroll:write') && ctx.companyWritable && ctx.mode === 'live' && !ctx.dryRun
      if (mayIssue) {
        const issued = await issuePayslipSections(ctx.supabase, {
          companyId: ctx.companyId!,
          run,
          settings: sectionSettings,
        })
        if (!issued.ok) {
          return v1ErrorResponse(issued.error, ctx.log, { requestId: ctx.requestId })
        }
        renderRun = { ...run, ...issued.snapshot }
      }
    }

    let pdfBuffer: Buffer
    let fileName: string
    try {
      const displayName = await getCompanyDisplayName(ctx.supabase, ctx.companyId!)
      const data = buildPayslipData({
        run: renderRun,
        sre,
        employee: emp,
        company: { name: displayName ?? company.name, org_number: company.org_number },
        audience,
      })
      fileName = payslipFileName(run, emp)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pdfBuffer = await renderToBuffer(PayslipPDF({ data }) as any)
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
