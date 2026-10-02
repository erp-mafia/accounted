/**
 * Salary payment files for agents:
 *
 *   salary-runs.payment-files.list   the files a run has had, as archived
 *
 * MCP only. The v1 doors already exist as the hand-written routes
 * POST /salary-runs/{id}/payment-file and GET /salary-runs/{id}/payment-files
 * (same operation id and scope); binding this operation to the list path
 * would change its public contract (it answers a bare paginated array there,
 * and an operation's output must be an object). Both doors read the archive
 * through listSalaryPaymentFiles (lib/salary/payment/payment-file-archive.ts).
 *
 * Metadata only, and no MCP door that builds a file. Same rule as the
 * supplier betalfil (supplier-payment-batches.ts): a payment file naming each
 * employee's account and net pay is not something an agent should carry
 * through a chat transcript, and the bank upload is a human step anyway.
 * Building one over MCP without handing it over would only add a second
 * payable file next to the one the salary run page builds on download (two
 * files for one run pay the month twice if both are uploaded). The agent can
 * tell which files exist, their format, checksum and totals, and send the user
 * to the salary run page for the file itself.
 */
import { z } from 'zod'
import { MAX_LIMIT } from '@/lib/api/v1/pagination'
import { dbError } from '@/lib/errors/db-error'
import { SALARY_PAYMENT_FILE_FORMATS } from '@/lib/salary/payment/build-payment-file'
import { listSalaryPaymentFiles } from '@/lib/salary/payment/payment-file-archive'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const EXAMPLE_RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const EXAMPLE_FILE_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'

const SALARY_RUN_ID = z.string().uuid().describe('The salary run (salary_run_id, e.g. from gnubok_get_salary_run).')

const ArchivedPaymentFile = z.object({
  payment_file_id: z.string().uuid().describe('The archived copy (salary_payment_files row).'),
  format: z.enum(SALARY_PAYMENT_FILE_FORMATS),
  filename: z.string(),
  content_type: z.enum(['application/xml', 'text/plain']),
  charset: z.enum(['utf-8', 'iso-8859-1']),
  sha256: z.string().describe('Lowercase hex SHA-256 over the file bytes: compare with the file uploaded in the bank.'),
  byte_size: z.number().int(),
  payment_date: z.string().describe('The execution date the file requests: the run\'s payment_date.'),
  employee_count: z.number().int().describe('Employees paid in the file (positive net payout).'),
  total_amount: z.number().describe('Sum of the net payouts in the file, SEK.'),
  generated_at: z.string(),
})

export const salaryRunsPaymentFilesList = defineOperation({
  id: 'salary-runs.payment-files.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the archived bank payment files of a salary run, newest first, without their content.',
    description:
      'Every payment file generated for the run (ISO 20022 pain.001 or Bankgirot LB), newest first: format, filename, sha256, byte size, payment date, employee count, total and when it was generated. Each row is the immutable archive copy written when the file was generated (BFL 7 kap. 1 §, seven-year retention). The file content is not returned here: the user downloads the file on the salary run page and uploads it in the bank. Paginated newest first; pass next_cursor back as cursor until it is null.',
    useWhen:
      'The user asks whether the salaries were put in a payment file, which format and total it had, or whether the file uploaded in the bank matches the archived one (compare sha256).',
    doNotUseFor:
      'Getting the file itself (the salary run page downloads it; over REST GET /salary-runs/{id}/payment-files returns the archived content), marking the run paid or booking it (gnubok_book_salary_run), or supplier payment batches.',
    pitfalls: [
      'An empty list means no file has been generated for the run yet (or the run predates the archive).',
      'Rows are immutable and never deleted; every download on the salary run page builds and archives a new row. Two files for one run are each payable: the user should upload exactly one in the bank.',
      'The newest row is not necessarily the one uploaded to the bank: compare sha256 with the file that was actually sent.',
    ],
    example: {
      response: {
        data: {
          salary_run_id: EXAMPLE_RUN_ID,
          salary_payment_files: [
            {
              payment_file_id: EXAMPLE_FILE_ID,
              format: 'pain001',
              filename: 'pain001_lon_2026-05.xml',
              content_type: 'application/xml',
              charset: 'utf-8',
              sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
              byte_size: 2731,
              payment_date: '2026-05-25',
              employee_count: 3,
              total_amount: 76500,
              generated_at: '2026-05-20T08:00:00.000Z',
            },
          ],
          next_cursor: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: SALARY_RUN_ID,
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(10).describe(`Page size, 1-${MAX_LIMIT} (default 10).`),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
  }),
  output: z.object({
    salary_run_id: z.string().uuid(),
    salary_payment_files: z.array(ArchivedPaymentFile),
    next_cursor: z.string().nullable(),
  }),
  errorCodes: ['SALARY_RUN_NOT_FOUND'],
  mcp: {
    name: 'gnubok_list_salary_payment_files',
    title: 'List Salary Payment Files',
    description:
      'The bank payment files generated for a salary run, newest first: format, filename, sha256 and totals of each archived pain.001 or Bankgirot LB file. No file content: the user downloads it on the salary run page. Paginate with cursor = next_cursor.',
    keywords: ['betalfiler lön', 'arkiverad betalfil', 'lönefil', 'utbetalningsfil', 'pain.001', 'bankgirot lb'],
  },
  run: async (ctx, { salary_run_id, limit, cursor }) => {
    const result = await listSalaryPaymentFiles(ctx.supabase, {
      companyId: ctx.companyId,
      salaryRunId: salary_run_id,
      limit,
      cursor,
    })
    if (!result.ok) {
      if (result.code === 'RUN_NOT_FOUND') return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
      return { ok: false, code: 'INTERNAL_ERROR', error: dbError(result.cause) }
    }
    // The archive rows carry the file; the agent gets everything but it.
    const salary_payment_files = result.files.map(({ content: _content, ...file }) => file)
    return {
      ok: true,
      data: { salary_run_id, salary_payment_files, next_cursor: result.nextCursor },
    }
  },
})
