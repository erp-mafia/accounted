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
import { v1OperationHandler } from '@/lib/operations/v1'
import { transactionsDelete, transactionsUpdate } from '@/lib/operations/transactions'
import { readTransactionParts } from '@/lib/transactions/parts-read'

const TransactionPartSuggestedInvoice = z.object({
  kind: z.enum(['customer_invoice', 'supplier_invoice']),
  invoice_id: z.string().uuid().describe('invoices.id or supplier_invoices.id, by kind: the id match-batch takes as invoice_id or supplier_invoice_id.'),
  invoice_number: z.string().nullable(),
  counterparty_name: z.string().nullable(),
  remaining_amount: z.number(),
  currency: z.string(),
})

const TransactionPart = z.object({
  part_id: z.string().uuid(),
  seq: z.number().int().describe('Position in the bank\'s order, from 1.'),
  amount: z.number().describe('Signed like the transaction; the parts sum to its amount.'),
  currency: z.string(),
  counterparty_name: z.string().nullable(),
  counterparty_org_number: z.string().nullable(),
  counterparty_account: z.string().nullable(),
  reference: z.string().nullable().describe('The OCR or payment reference the payer quoted.'),
  invoice_numbers: z.array(z.string()),
  message: z.string().nullable(),
  suggestion_reason: z.enum(['ocr_exact', 'invoice_number', 'amount_only']).nullable(),
  suggested_invoice: TransactionPartSuggestedInvoice.nullable().describe('The open invoice ingest suggests this part pays. A suggestion: book it through match-batch.'),
})

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
  counterparty_org_number: z.string().nullable().optional().describe('The counterparty\'s organisationsnummer, digits only, when the bank\'s enrichment names it.'),
  instructed_amount: z.number().nullable().optional().describe('The amount in the currency the payment was made in, when that differs from the account currency (a card purchase abroad).'),
  instructed_currency: z.string().nullable().optional().describe('The currency of instructed_amount.'),
  balance_after: z.number().nullable().optional().describe('The account balance after this transaction as the bank reports it; null for personal accounts and feeds that send none.'),
  is_enriched: z.boolean().nullable().optional().describe('Open Payments: the row has been through the bank\'s daily enrichment (payer name, organisationsnummer, OCR reference). Null when the bank sends no flag.'),
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
  cash_account_id: z.string().uuid().nullable(),
  potential_match_method: z.string().nullable().optional().describe('"bankgiro_split" when the parts below all resolved to open invoices and sum to the amount: pass them as match-batch allocations.'),
  parts: z.array(TransactionPart).optional().describe('The Bankgirot split of the row (Open Payments): one part per payer or payee, in the bank\'s order, with the invoice ingest suggests for each. Empty for a row without a split.'),
  created_at: z.string(),
  updated_at: z.string(),
})

// Detail endpoint carve-out: a single-row drill-in is the user's intentional
// request for the full row. Verbose by design: list endpoint stays minimal.
const TRANSACTION_DETAIL_COLUMNS =
  'id, date, description, amount, currency, amount_sek, reference, merchant_name, ' +
  'counterparty_account, counterparty_org_number, instructed_amount, instructed_currency, ' +
  'balance_after, is_enriched, journal_entry_id, invoice_id, supplier_invoice_id, ' +
  'potential_invoice_id, is_business, category, receipt_id, document_id, ' +
  'external_id, import_source, reconciliation_method, cash_account_id, potential_match_method, created_at, updated_at'

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
    'parts is the Bankgirot split of an Open Payments row (one part per payer or payee with the suggested invoice). With potential_match_method "bankgiro_split" every part resolved: settle them in one call with POST .../transactions/{id}/match-batch, one allocation per part (kind, the suggested invoice id, the part amount).',
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
    // The Bankgirot split, when the row carries one (Open Payments, or a BG Max
    // deposit file on a row from any feed). A refused read fails the detail:
    // a split silently missing would read as "no split".
    let parts
    try {
      parts = await readTransactionParts(ctx.supabase, ctx.companyId!, idParse.data)
    } catch (partsError) {
      return v1ErrorResponse(partsError, ctx.log, { requestId: ctx.requestId })
    }
    return ok({ ...(data as unknown as Record<string, unknown>), parts }, { requestId: ctx.requestId })
  },
)

/**
 * DELETE: delete an unbooked, hand-added transaction (operation
 * transactions.delete). PATCH: edit the working title or move the row to
 * another cash account (operation transactions.update). Contracts, docs and
 * rules in src/lib/operations/transactions.ts.
 */
export const DELETE = v1OperationHandler(transactionsDelete)
export const PATCH = v1OperationHandler(transactionsUpdate)
