/**
 * GET /api/v1/companies/{companyId}/transactions/{id}
 *
 * Single transaction detail. Includes match state (invoice, supplier
 * invoice), booking state (journal_entry_id), and import metadata.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const TransactionDetail = z.object({
  id: z.string().uuid(),
  date: z.string(),
  description: z.string().nullable(),
  amount: z.number(),
  currency: z.string(),
  amount_sek: z.number().nullable(),
  reference: z.string().nullable(),
  merchant_name: z.string().nullable(),
  counterparty_account: z.string().nullable(),
  journal_entry_id: z.string().uuid().nullable(),
  invoice_id: z.string().uuid().nullable(),
  supplier_invoice_id: z.string().uuid().nullable(),
  potential_invoice_id: z.string().uuid().nullable(),
  is_business: z.boolean().nullable(),
  category: z.string().nullable(),
  receipt_id: z.string().uuid().nullable(),
  document_id: z.string().uuid().nullable(),
  external_id: z.string().nullable(),
  import_source: z.string().nullable(),
  reconciliation_method: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

// Detail endpoint carve-out: a single-row drill-in is the user's intentional
// request for the full row. Verbose by design: list endpoint stays minimal.
const TRANSACTION_DETAIL_COLUMNS =
  'id, date, description, amount, currency, amount_sek, reference, merchant_name, ' +
  'counterparty_account, journal_entry_id, invoice_id, supplier_invoice_id, ' +
  'potential_invoice_id, is_business, category, receipt_id, document_id, ' +
  'external_id, import_source, reconciliation_method, created_at, updated_at'

registerEndpoint({
  operation: 'transactions.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/transactions/:id',
  summary: 'Retrieve a single transaction by id.',
  description: 'Returns the full transaction record including match state, booking state, and import metadata.',
  useWhen:
    'You have a transaction id (from the list or a webhook) and need the full record before deciding to categorize, match, or attach a document.',
  doNotUseFor:
    'Walking the ledger: use the list endpoint with a cursor. Fetching the linked invoice/journal entry: separate endpoints.',
  pitfalls: [
    'Both invoice_id (matched) and potential_invoice_id (suggested) can be set independently. The matched id is authoritative for accounting.',
    'reconciliation_method is null for transactions that have never been auto-reconciled. journal_entry_id may still be set via manual categorize.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        date: '2026-05-12',
        amount: -349.5,
        currency: 'SEK',
        journal_entry_id: null,
        is_business: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(TransactionDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('transactions')
      .select(TRANSACTION_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) {
      ctx.log.warn('transactions.get: not found', { id: idParse.data })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'transaction' },
      })
    }
    return ok(data, { requestId: ctx.requestId })
  },
)
