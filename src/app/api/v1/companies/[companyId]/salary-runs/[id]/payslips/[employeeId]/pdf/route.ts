/**
 * GET /api/v1/companies/{companyId}/salary-runs/{id}/payslips/{employeeId}/pdf
 *
 * Render one employee's payslip as application/pdf. Byte-equivalent to the
 * dashboard download: data assembly is shared via
 * lib/salary/payslips/build-payslip-data.
 *
 * Per BFL: payslips are räkenskapsinformation linked to posted journal
 * entries (7-year retention). Read-only: no Idempotency-Key, no dry-run.
 */

import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF } from '@/lib/salary/pdf/payslip-template'
import { buildPayslipData, payslipFileName } from '@/lib/salary/payslips/build-payslip-data'
import { contentDisposition } from '@/lib/api/content-disposition'
import { getCompanyDisplayName } from '@/lib/company/context'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

registerEndpoint({
  operation: 'salary-runs.payslip.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs/:id/payslips/:employeeId/pdf',
  summary: 'Download one employee\'s payslip as PDF.',
  description:
    'Returns the rendered payslip (lönespecifikation) as application/pdf, byte-equivalent to the dashboard download. Content-Disposition is attachment with a filename derived from the period and employee name.',
  useWhen:
    'You need the payslip document itself: archiving, forwarding to the employee outside the Accounted send flow, or attaching to an external HR system.',
  doNotUseFor:
    'The payslip DATA (amounts, line items): use GET /salary-runs/{id}/employees/{employeeId}, which is cheaper and structured. Emailing payslips to employees: the send flow is internal-only today.',
  pitfalls: [
    'The PDF renders whatever the run currently holds: for a draft run that has not been calculated, amounts are 0.',
    'PDF rendering takes a few hundred milliseconds; cache on the client if requesting repeatedly.',
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
  response: {
    success: z.unknown(), // Marker: binary response, see contentType.
    contentType: 'application/pdf',
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string; employeeId: string }> }>(
  'salary-runs.payslip.pdf',
  async (_request, ctx, params) => {
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

    let pdfBuffer: Buffer
    let fileName: string
    try {
      const displayName = await getCompanyDisplayName(ctx.supabase, ctx.companyId!)
      const data = buildPayslipData({
        run,
        sre,
        employee: emp,
        company: { name: displayName ?? company.name, org_number: company.org_number },
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
