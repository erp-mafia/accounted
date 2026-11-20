/**
 * Fora's monthly report, for agents and API keys:
 *
 *   salary-runs.fora-report.get   who is reported to Fora for a payment month, with
 *                            what code and pay, and what to fix first
 *
 * v1 (GET /salary/fora-report) and MCP (search-only). Both doors read the
 * same service as the dashboard download (lib/salary/fora/monthly-report.ts).
 *
 * The summary only, never the file. The file names every worker by full
 * personnummer, and an MCP answer is a chat transcript: personnummer stay
 * masked on MCP (as gnubok_get_employee does). Same rule as the salary
 * payment files (salary-payment-files.ts): the user downloads the file on the
 * salary run page and uploads it on Fora's Mina sidor, a human step anyway.
 */
import { z } from 'zod'
import { dbError } from '@/lib/errors/db-error'
import { generateForaMonthlyReport } from '@/lib/salary/fora/monthly-report'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const EXAMPLE_EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const EXAMPLE_RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const ForaWarningSchema = z.object({
  code: z.enum(['FORA_PAID_BEFORE_CODE_START', 'FORA_NEGATIVE_PAY', 'FORA_RUN_NOT_APPROVED', 'FORA_ARBETARE_WITHOUT_CODE']),
  message: z.string().describe('What to check, in Swedish.'),
  employee_id: z.string().uuid().optional(),
  employee_name: z.string().optional(),
  fok_start_date: z.string().optional(),
  pay_amount: z.number().int().optional(),
  salary_run_id: z.string().uuid().optional(),
  run_period: z.string().optional(),
  payment_date: z.string().optional(),
})

export const salaryForaReportGet = defineOperation({
  id: 'salary-runs.fora-report.get',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The Fora monthly report for a payment month: each coded worker, their FOK code and the pay Fora is told about.',
    description:
      'Employers with workers under Avtalspension SAF-LO (usually arbetare) report each worker\'s cash gross pay to Fora every month, by the last day of the month after the payment month, by uploading a JSON file on Fora\'s Mina sidor. This answers what that file says for one payment month: every employee with a Fora code (fora_fok_id on the employee) who was employed or paid in the month, their code, the pay in whole kronor and the employment end date, plus warnings to look at before uploading. The month is the payment month (payment_date), like the AGI; approved, paid and booked salary runs count. Pay is the bruttolön minus taxable traktamente and taxable car allowance, which Fora leaves out. Nothing is stored: a regenerated file replaces the month at Fora.',
    useWhen:
      'The user asks what to report to Fora for a month, why a worker is missing from the Fora file, or whether the Fora figures match the payroll.',
    doNotUseFor:
      'Getting the file itself (the user opens "Fora-fil" in the salary run page\'s menu and downloads it there), the yearly total for tjänstemän (GET /reports/salary-journal groupTotals), or Fora\'s premiums (Fora invoices them).',
    pitfalls: [
      'An employee is only reported with a Fora code: set fora_fok_id and fora_fok_start_date on the employee (the code is on Fora\'s Mina sidor, FOK plus six digits). Owners and board members never get one.',
      'A draft or a salary run in review is not in the month: approve it first (warning FORA_RUN_NOT_APPROVED).',
      'A worker with a code and no payout in the month is reported with pay_amount 0, as Fora asks for every marked-up worker every month.',
      'Bonus earned in earlier months is reported in the payment month; attributing it to the months it was earned is not supported yet.',
      '400 FORA_REPORT_INCOMPLETE lists in details.issues what blocks the file: FORA_ORG_NUMBER_MISSING, FORA_ADDRESS_REQUIRED (a samordningsnummer needs street, postal code and city), FORA_NO_CODED_EMPLOYEES or FORA_NOTHING_IN_MONTH.',
    ],
    example: {
      request: { year: 2026, month: 10 },
      response: {
        data: {
          year: 2026,
          month: 10,
          filename: 'Fora_5565601712_202610.json',
          payrolls: [
            {
              employee_id: EXAMPLE_EMPLOYEE_ID,
              employee_name: 'Kalle Hall',
              personnummer_masked: '19540801-XXXX',
              fok_id: 'FOK306834',
              pay_amount: 31250,
              employment_end: null,
            },
          ],
          employee_count: 1,
          total_pay_amount: 31250,
          salary_run_ids: [EXAMPLE_RUN_ID],
          warnings: [],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    year: z.coerce.number().int().min(2024).max(2100).describe('Payment year.'),
    month: z.coerce.number().int().min(1).max(12).describe('Payment month, 1-12.'),
  }),
  output: z.object({
    year: z.number().int(),
    month: z.number().int(),
    filename: z.string().describe('The file name the salary run page downloads.'),
    payrolls: z.array(
      z.object({
        employee_id: z.string().uuid(),
        employee_name: z.string(),
        personnummer_masked: z.string(),
        fok_id: z.string(),
        pay_amount: z.number().int().describe('Whole kronor, as in the file.'),
        employment_end: z.string().nullable(),
      }),
    ),
    employee_count: z.number().int(),
    total_pay_amount: z.number().int(),
    salary_run_ids: z.array(z.string().uuid()).describe('The salary runs whose pay is in the month.'),
    warnings: z.array(ForaWarningSchema),
  }),
  errorCodes: ['FORA_REPORT_INCOMPLETE'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/salary/fora-report' },
  mcp: {
    name: 'gnubok_get_fora_report',
    title: 'Get Fora Report',
    description:
      'What the monthly Fora file says for a payment month: each worker with a Fora code, the code and the pay in whole kronor, plus warnings. Masked personnummer; the user downloads the file on the salary run page.',
    visibility: 'search',
    keywords: ['fora', 'fora-fil', 'avtalspension', 'saf-lo', 'uppmärkning', 'fok', 'kollektivavtal', 'arbetare', 'månadsrapportering'],
  },
  run: async (ctx, { year, month }) => {
    const result = await generateForaMonthlyReport(ctx.supabase, { companyId: ctx.companyId, year, month })
    if (!result.ok) {
      if (result.code === 'FORA_REPORT_INCOMPLETE') {
        return { ok: false, code: 'FORA_REPORT_INCOMPLETE', details: { issues: result.issues } }
      }
      if (result.code === 'COMPANY_NOT_FOUND') return { ok: false, code: 'COMPANY_NOT_FOUND' }
      return { ok: false, code: 'INTERNAL_ERROR', error: dbError(result.cause) }
    }
    const { file: _file, ...report } = result.data
    return { ok: true, data: { ...report, employee_count: report.payrolls.length } }
  },
})
