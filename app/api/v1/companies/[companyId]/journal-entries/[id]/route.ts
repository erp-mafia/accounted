/**
 * GET /api/v1/companies/{companyId}/journal-entries/{id}
 *
 * Returns the full verifikation including lines, source links
 * (reverses_id, reversed_by_id, correction_of_id), and dimensions.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const JE_LINE_COLUMNS =
  'id, account_number, debit_amount, credit_amount, line_description, currency, amount_in_currency, exchange_rate, tax_code, cost_center, project, sort_order'
const JE_DETAIL_COLUMNS =
  'id, fiscal_period_id, voucher_series, voucher_number, entry_date, description, status, source_type, source_id, notes, reverses_id, reversed_by_id, correction_of_id, created_at, updated_at'

const JournalEntryLine = z.object({
  id: z.string().uuid(),
  account_number: z.string(),
  debit_amount: z.number(),
  credit_amount: z.number(),
  line_description: z.string().nullable(),
  currency: z.string().nullable(),
  amount_in_currency: z.number().nullable(),
  exchange_rate: z.number().nullable(),
  tax_code: z.string().nullable(),
  cost_center: z.string().nullable(),
  project: z.string().nullable(),
  sort_order: z.number().int(),
})

const JournalEntryDetail = z.object({
  id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  entry_date: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'posted', 'cancelled']),
  source_type: z.string(),
  source_id: z.string().nullable(),
  notes: z.string().nullable(),
  reverses_id: z.string().uuid().nullable(),
  reversed_by_id: z.string().uuid().nullable(),
  correction_of_id: z.string().uuid().nullable(),
  lines: z.array(JournalEntryLine),
  created_at: z.string(),
  updated_at: z.string(),
})

registerEndpoint({
  operation: 'journal-entries.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/journal-entries/:id',
  summary: 'Retrieve a single verifikation by id.',
  description:
    'Returns the full journal entry including all lines, dimensions, and the storno chain (reverses_id, reversed_by_id, correction_of_id).',
  useWhen:
    'You need the full verifikation for audit / reconciliation, or to display the line-by-line breakdown.',
  doNotUseFor:
    'Listing entries (use the list endpoint with filters).',
  pitfalls: [
    'Cancelled drafts are returned (no filter on status here); inspect status before assuming the entry is posted.',
    'Lines are sorted by sort_order; the order matters for display but not for accounting (the sum across lines is the meaningful quantity).',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        voucher_series: 'A',
        voucher_number: 142,
        entry_date: '2026-05-12',
        status: 'posted',
        lines: [
          { account_number: '6570', debit_amount: 50, credit_amount: 0, sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 50, sort_order: 1 },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(JournalEntryDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('journal_entries')
      .select(`${JE_DETAIL_COLUMNS}, lines:journal_entry_lines(${JE_LINE_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    return ok(data, { requestId: ctx.requestId })
  },
)
