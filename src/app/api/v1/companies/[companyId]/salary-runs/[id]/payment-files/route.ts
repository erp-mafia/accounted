/**
 * GET /api/v1/companies/{companyId}/salary-runs/{id}/payment-files
 *
 * Lists the archived bank payment files of a salary run, newest first, with
 * the file content inline. Every file the payment-file endpoint (or the
 * dashboard download) generates is archived as an immutable
 * salary_payment_files row before it is handed out (BFL 7 kap. 1 §,
 * seven-year retention), so this list is the record of what was actually
 * sent to the bank: a regeneration after a bank-detail change produces a new
 * row and never rewrites an old one.
 *
 * sha256 and byte_size are over the file bytes in `charset` (UTF-8 for
 * pain001, ISO 8859-1 for bg_lb), the same bytes the download sends, so a
 * copy from the bank's file channel can be verified against the archive.
 *
 * Cursor pagination on (generated_at DESC, id DESC).
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
  PaginationQueryShape,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { SALARY_PAYMENT_FILE_FORMATS } from '@/lib/salary/payment/build-payment-file'

const ArchivedSalaryPaymentFile = z.object({
  /** Id of the archived row (the payment_file_id the generate call returned). */
  payment_file_id: z.string().uuid(),
  format: z.enum(SALARY_PAYMENT_FILE_FORMATS),
  filename: z.string(),
  content_type: z.enum(['application/xml', 'text/plain']),
  /** Encoding of `content` as downloaded; sha256 and byte_size are over those bytes. */
  charset: z.enum(['utf-8', 'iso-8859-1']),
  /** Lowercase hex SHA-256 over the file bytes in `charset`. */
  sha256: z.string(),
  byte_size: z.number().int(),
  payment_date: z.string(),
  /** Employees with a positive net payout (credit transfers in the file). */
  employee_count: z.number().int(),
  total_amount: z.number(),
  generated_at: z.string(),
  /** The file exactly as generated. Write it to disk under `filename` in `charset`. */
  content: z.string(),
})

// Explicit projection: never SELECT *. One literal so the phantom-column
// guard (tests/schema) can check every name against the migration.
registerEndpoint({
  operation: 'salary-runs.payment-files.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary-runs/:id/payment-files',
  summary: 'List the archived bank payment files of a salary run.',
  description:
    'Returns every payment file generated for the run (ISO 20022 pain.001 or Bankgirot LB), newest first, with the file content inline. Each row is an immutable archive copy written when the file was generated (BFL 7 kap. 1 §, seven-year retention): what was handed to the bank, byte for byte. sha256 and byte_size are over `content` encoded as `charset` (UTF-8 for pain001, ISO 8859-1 for bg_lb). Cursor pagination on (generated_at, id), newest first.',
  useWhen:
    'You need the file that was actually generated earlier (to re-upload, to verify a checksum against the bank portal, or to audit what the bank received) rather than a fresh build from the run\'s current data.',
  doNotUseFor:
    'Generating a file: use POST /salary-runs/{id}/payment-file. Marking the run paid (:mark-paid) or booking it (:book). Supplier payment batches: use the supplier-invoice payment batch endpoints.',
  pitfalls: [
    'An empty list means no file has been generated for the run yet (or the run predates the archive): generate one with POST /salary-runs/{id}/payment-file.',
    'Rows are immutable and never deleted; a regeneration adds a new row. The newest row is not necessarily the one uploaded to the bank: compare sha256 with the checksum of the file you actually sent.',
    'Write `content` to disk in `charset` (pain001 as UTF-8, bg_lb as ISO 8859-1 with CRLF line endings, exactly as returned); sha256 and byte_size describe those bytes, not the JSON string.',
    'Every row carries the full file content, so page size matters for runs with many regenerations: use `limit` and the cursor.',
  ],
  example: {
    response: {
      data: [
        {
          payment_file_id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
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
          content:
            '<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CstmrCdtTrfInitn>…</CstmrCdtTrfInitn></Document>',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: z.object({ ...PaginationQueryShape }) },
  response: { success: listEnvelope(ArchivedSalaryPaymentFile) },
})

type Row = {
  id: string
  format: 'pain001' | 'bg_lb'
  filename: string
  content_type: 'application/xml' | 'text/plain'
  charset: 'utf-8' | 'iso-8859-1'
  sha256: string
  byte_size: number
  payment_date: string
  employee_count: number
  total_amount: number | string
  generated_at: string
  content: string
}

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary-runs.payment-files.list',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Salary-run id must be a UUID.' },
      })
    }

    // 404 the run itself first so an empty list unambiguously means
    // "run exists, no file generated yet".
    const { data: run, error: runErr } = await ctx.supabase
      .from('salary_runs')
      .select('id')
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()
    if (runErr) {
      return v1ErrorResponse(runErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!run) {
      return v1ErrorResponseFromCode('SALARY_RUN_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    // The default cursor carries (created_at, id); here the timestamp is
    // generated_at, the archive row's only clock.
    const decoded = decodeDefaultCursor(cursor)

    let query = ctx.supabase
      .from('salary_payment_files')
      .select('id, format, filename, content_type, charset, sha256, byte_size, payment_date, employee_count, total_amount, generated_at, content')
      .eq('company_id', ctx.companyId!)
      .eq('salary_run_id', idParse.data)
      .order('generated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (decoded) {
      query = query.or(
        `generated_at.lt.${decoded.ts},and(generated_at.eq.${decoded.ts},id.lt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const items = trimmed.map((r) => ({
      payment_file_id: r.id,
      format: r.format,
      filename: r.filename,
      content_type: r.content_type,
      charset: r.charset,
      sha256: r.sha256,
      byte_size: r.byte_size,
      payment_date: r.payment_date,
      employee_count: r.employee_count,
      total_amount: Number(r.total_amount),
      generated_at: r.generated_at,
      content: r.content,
    }))

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.generated_at })
      : null

    return paginated(items, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)
