/**
 * POST /api/v1/companies/{companyId}/invoices/bulk-create
 *
 * Bulk create draft invoices in one call. Each invoice in the request array
 * is validated and inserted independently. The response is partial-success
 * by default: items that fail don't roll back items that succeeded.
 *
 * Request:
 *   {
 *     invoices: CreateInvoiceSchema[],  // 1..50 items
 *     all_or_nothing?: boolean          // default false. Passing true returns
 *                                       // 501 NOT_IMPLEMENTED: the flag is
 *                                       // reserved for a future DB-side RPC.
 *   }
 *
 * Response (200):
 *   {
 *     results: [
 *       { ok: true,  request_index: 0, data: { id, invoice_number, total, ... } },
 *       { ok: false, request_index: 1, error: { code, message, details? } },
 *       ...
 *     ],
 *     summary: { total: N, succeeded: X, failed: Y }
 *   }
 *
 * Idempotent (mandatory Idempotency-Key applies to the whole batch: replays
 * return the cached full result, not per-item retries). Dry-runnable.
 *
 * Limits:
 *   - 50 invoices per request. Larger imports should be split.
 *   - No transactional guarantee between items today; the all_or_nothing
 *     flag is reserved for a future RPC implementation.
 *   - Quotes (document_type 'quote') are not supported. A quote is a single
 *     document with its own OF-number series, valid_until and quote_status,
 *     none of which this path assigns; a quote item is refused per item as
 *     VALIDATION_ERROR without inserting anything. Use POST /invoices with
 *     document_type quote instead.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateInvoiceSchema } from '@/lib/api/schemas'
import type { InvoiceVatWarning } from '@/lib/invoices/vat-rules'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { yourReferenceForNewInvoice } from '@/lib/customers/invoice-reference'
import { invoiceMarkingForNewInvoice } from '@/lib/customers/invoice-marking'
import { resolveInvoicePayeeChoice } from '@/lib/invoices/invoice-payee'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import type { Invoice, InvoiceDocumentType } from '@/types'

const BulkCreateRequest = z.object({
  invoices: z.array(CreateInvoiceSchema).min(1).max(50),
  all_or_nothing: z.boolean().optional().default(false),
})

const BulkResultItem = z.object({
  ok: z.boolean(),
  request_index: z.number().int().nonnegative(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
})

const BulkCreateResponse = z.object({
  results: z.array(BulkResultItem),
  summary: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
})

const INVOICE_BULK_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, status, currency, subtotal, vat_amount, total, document_type, created_at'

registerEndpoint({
  operation: 'invoices.bulk-create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/bulk-create',
  summary: 'Create up to 50 draft invoices in one call (partial-success).',
  description:
    'Bulk-creation endpoint. Each invoice in the request array is validated and inserted independently. By default, individual failures do not roll back successes: the response carries a per-item results array with ok/error markers and a summary. Idempotent (the whole batch is keyed by the single Idempotency-Key). Dry-runnable.',
  useWhen:
    'You\'re importing a batch of invoices from another system, or producing many invoices programmatically (e.g. monthly subscription billing). Use dry-run first to validate the whole batch before committing.',
  doNotUseFor:
    'Sending the same invoice to multiple customers: POST /invoices once per customer. Long-running imports of > 50 invoices: split into pages. Transactional all-or-nothing imports: not yet supported (passing all_or_nothing: true returns 501 NOT_IMPLEMENTED; the flag is reserved for a future RPC).',
  pitfalls: [
    'Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.',
    'Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag (or pass false).',
    'Each item is built exactly like POST /invoices: the same fields (line discounts, text rows, articles, posting accounts, periodisering, ROT/RUT, per-invoice VAT treatment, payee account) and the same validation and error codes. A failing item is a per-item failure, not a whole-batch failure.',
    'Currency conversion is best-effort PER ITEM. A failed Riksbanken fetch leaves that item\'s SEK columns null but does NOT fail the item.',
    'Quotes (document_type: quote) are refused per item as VALIDATION_ERROR: a quote carries its own OF-number, valid_until and quote_status. Create quotes one at a time with POST /invoices.',
    'Self-billing invoices (is_self_billed: true) are refused per item as VALIDATION_ERROR: they are booked at once, not drafted. Register them one at a time with POST /invoices.',
  ],
  example: {
    request: {
      invoices: [
        {
          customer_id: 'a8f1…',
          invoice_date: '2026-05-12',
          due_date: '2026-06-11',
          currency: 'SEK',
          items: [{ description: 'A', quantity: 1, unit: 'st', unit_price: 1000 }],
        },
      ],
    },
    response: {
      data: {
        results: [
          {
            ok: true,
            request_index: 0,
            data: {
              id: '0e9c…',
              invoice_number: null,
              status: 'draft',
              total: 1250,
            },
          },
        ],
        summary: { total: 1, succeeded: 1, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: BulkCreateRequest },
  response: { success: dataEnvelope(BulkCreateResponse) },
})

interface ResultItem {
  ok: boolean
  request_index: number
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
  /** Non-blocking VAT-treatment warnings for a created item (POST /invoices meta.warnings parity). */
  warnings?: InvoiceVatWarning[]
}

/**
 * A per-item failure for a code the builder or the payee check returned,
 * with the code's registered English message. The VAT rule violation keeps
 * the snake_case details POST /invoices documents for it (the builder emits
 * camelCase, the internal-route convention).
 */
function buildFailure(code: string, details?: Record<string, unknown>): NonNullable<ResultItem['error']> {
  const wireDetails =
    code === 'INVOICE_CREATE_VAT_RULE_VIOLATION' && details
      ? {
          attempted_rate: details.attemptedRate,
          allowed_rates: details.allowedRates,
          customer_type: details.customerType,
        }
      : details
  return {
    code,
    message: getErrorEntry(code)?.message_en ?? 'The invoice was not created: see the error code and details.',
    ...(wireDetails !== undefined ? { details: wireDetails } : {}),
  }
}

/**
 * Create one invoice (the bulk-create item path). Builds the rows with the
 * same buildInvoiceWriteData + resolveInvoicePayeeChoice as POST
 * /invoices/route.ts, so a bulk-created invoice is the invoice POST /invoices
 * creates from the same body. Returns a ResultItem instead of an HTTP
 * response so the caller can aggregate.
 *
 * TODO: move the insert, rollback and event below into a shared lib
 * function with POST /invoices as well. Tracked as cross-route cleanup.
 */
async function createOneInvoice(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  index: number,
  input: z.infer<typeof CreateInvoiceSchema>,
  dryRun: boolean,
  log: Logger,
): Promise<ResultItem> {
  const documentType: InvoiceDocumentType = input.document_type || 'invoice'

  // CreateInvoiceSchema accepts document_type 'quote', but this path never
  // assigns the OF-number, valid_until or quote_status the DB CHECK requires
  // for a quote (pg 23514). Refuse before touching the database so the item
  // fails cleanly and the rest of the batch is unaffected.
  if (documentType === 'quote') {
    return {
      ok: false,
      request_index: index,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Quotes are not supported by bulk-create.',
        details: {
          field: 'document_type',
          message: 'Quotes are not supported by bulk-create; use POST /invoices with document_type quote.',
        },
      },
    }
  }

  // A self-billing invoice (mottagen självfaktura) is not a draft: POST
  // /invoices books it at once with the counterparty's number. Creating a
  // draft here instead would hand the caller something it did not ask for.
  if (input.is_self_billed) {
    return {
      ok: false,
      request_index: index,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Self-billing invoices are not supported by bulk-create.',
        details: {
          field: 'is_self_billed',
          message: 'Self-billing invoices are booked at once; register each one with POST /invoices.',
        },
      },
    }
  }

  // Customer fetch (scoped to company), the same columns POST /invoices
  // reads. The builder writes the DB-returned `customer.id`, not
  // `input.customer_id` blindly: the .eq() pair already enforces company
  // scoping, and the builder's customer type makes every column it reads a
  // required key, so a column dropped from this literal no longer compiles.
  const { data: customer } = await supabase
    .from('customers')
    .select('id, customer_type, vat_number, vat_number_validated, country, invoice_reference, invoice_marking')
    .eq('company_id', companyId)
    .eq('id', input.customer_id)
    .maybeSingle()
  if (!customer) {
    return {
      ok: false,
      request_index: index,
      error: { code: 'INVOICE_CUSTOMER_NOT_FOUND', message: 'Customer not found in this company.' },
    }
  }

  // The shared write-builder POST /invoices and the dashboard use: VAT rule
  // gating, line discounts, text rows, article and posting-account checks,
  // periodisering, server-side ROT/RUT and personnummer encryption, the
  // per-invoice VAT treatment and the taxable-event exchange rate. This door
  // used to compute its own rows from part of the schema and silently drop
  // the rest, so a discounted line was invoiced at full price.
  const build = await buildInvoiceWriteData({
    supabase,
    companyId,
    // personal_number is withheld (PII), as on POST /invoices: a v1 caller
    // sends deduction_personnummer for a ROT/RUT line.
    customer: { ...customer, personal_number: null },
    documentType,
    // Er referens and Märkning: the request's, else the customer card's
    // Fakturareferens (crm#1200) and Märkning (crm#1477), as on POST /invoices.
    input: {
      ...input,
      your_reference: yourReferenceForNewInvoice(input.your_reference, customer) ?? undefined,
      invoice_marking: invoiceMarkingForNewInvoice(input.invoice_marking, customer) ?? undefined,
    },
  })
  if (!build.ok) {
    if ('dbError' in build) {
      log.error('bulk-create: invoice build lookup failed', build.dbError as Error, { request_index: index })
      const structured = getStructuredError(build.dbError)
      return { ok: false, request_index: index, error: { code: structured.code, message: structured.message_en } }
    }
    return { ok: false, request_index: index, error: buildFailure(build.code, build.details) }
  }
  const { invoiceFields, items: itemRows } = build
  const warningsField = build.warnings.length > 0 ? { warnings: build.warnings } : {}

  const payeeChoice = await resolveInvoicePayeeChoice(supabase, companyId, input.currency, input.payment_cash_account_id)
  if (!payeeChoice.ok) {
    return { ok: false, request_index: index, error: buildFailure(payeeChoice.code, payeeChoice.details) }
  }

  if (dryRun) {
    // Never echo the encrypted personnummer blob in a preview; last4 is the
    // display-safe representation, as on POST /invoices.
    const { deduction_personnummer_encrypted: _omit, ...previewFields } = invoiceFields
    return {
      ok: true,
      request_index: index,
      ...warningsField,
      data: {
        preview: {
          invoice_number: null,
          status: 'draft' as const,
          ...previewFields,
          ...payeeChoice.fields,
          items: itemRows,
        },
      },
    }
  }

  // Commit path. Insert invoice header.
  const { data: invoice, error: invoiceErr } = await supabase
    .from('invoices')
    .insert({
      user_id: userId,
      company_id: companyId,
      invoice_number: null,
      ...invoiceFields,
      payment_cash_account_id: payeeChoice.fields.payment_cash_account_id,
      payment_details: payeeChoice.fields.payment_details,
    })
    .select(INVOICE_BULK_RESPONSE_COLUMNS)
    .single()

  if (invoiceErr) {
    log.error('bulk-create: invoice insert failed', invoiceErr, {
      request_index: index,
      companyId,
      pgCode: invoiceErr.code,
    })
    return {
      ok: false,
      request_index: index,
      error: {
        code: 'INVOICE_CREATE_INSERT_FAILED',
        message: 'Invoice insert failed.',
        details: { pg_code: invoiceErr.code },
      },
    }
  }

  const invoiceId = (invoice as { id: string }).id
  const itemsToInsert = itemRows.map((r) => ({ ...r, invoice_id: invoiceId }))
  const { error: itemsErr } = await supabase.from('invoice_items').insert(itemsToInsert)
  if (itemsErr) {
    // Roll back this invoice; other batch items are unaffected.
    const { error: rbErr } = await supabase
      .from('invoices')
      .delete()
      .eq('id', invoiceId)
      .eq('company_id', companyId)
    if (rbErr) {
      log.error(
        'bulk-create: items insert failed AND rollback delete failed, orphaned header',
        rbErr,
        { request_index: index, invoiceId, companyId, originalPgCode: itemsErr.code },
      )
    } else {
      log.error('bulk-create: items insert failed; rolled back invoice', itemsErr, {
        request_index: index,
        invoiceId,
        companyId,
      })
    }
    return {
      ok: false,
      request_index: index,
      error: {
        code: 'INVOICE_CREATE_ITEMS_FAILED',
        message: 'Invoice items insert failed; the invoice was rolled back.',
        details: { pg_code: itemsErr.code },
      },
    }
  }

  // Emit invoice.created per successful item (matches POST /invoices).
  if (documentType === 'invoice') {
    try {
      await eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: invoice as unknown as Invoice, companyId, userId },
      })
    } catch (err) {
      log.warn('bulk-create: invoice.created emit failed', err as Error, {
        request_index: index,
        invoiceId,
      })
    }
  }

  return { ok: true, request_index: index, ...warningsField, data: invoice }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'invoices.bulk-create',
  async (request, ctx) => {
    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = BulkCreateRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    // Reject all_or_nothing: true loudly. The schema accepts it for forward
    // compatibility, but a caller asking for atomic semantics must not get
    // partial-success behaviour silently: that would let an automation
    // depend on a guarantee that doesn't exist. The flag will be honored
    // once a DB-side RPC ships; until then it's 501.
    if (body.all_or_nothing) {
      return v1ErrorResponseFromCode('NOT_IMPLEMENTED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'all_or_nothing',
          message:
            'all_or_nothing: true is not yet implemented. Omit the flag (or pass false) to use partial-success semantics.',
        },
      })
    }

    // Run items sequentially. Parallel would be faster but the database-side
    // sequence allocation for delivery notes and the auditability of the
    // log stream are easier to reason about sequentially. 50-item cap keeps
    // the worst-case latency bounded.
    const results: ResultItem[] = []
    for (let i = 0; i < body.invoices.length; i++) {
      // An unexpected throw (a payee or encryption failure) fails its own
      // item: letting it escape would answer 500 for a batch whose earlier
      // items are already inserted, and a retry would create them twice.
      try {
        results.push(
          await createOneInvoice(ctx.supabase, ctx.companyId!, ctx.userId, i, body.invoices[i], ctx.dryRun, ctx.log),
        )
      } catch (err) {
        ctx.log.error('bulk-create: item failed unexpectedly', err as Error, { request_index: i })
        const structured = getStructuredError(err)
        results.push({ ok: false, request_index: i, error: { code: structured.code, message: structured.message_en } })
      }
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    ctx.log.info('invoices.bulk-create completed', {
      companyId: ctx.companyId,
      userId: ctx.userId,
      ...summary,
      dryRun: ctx.dryRun,
    })

    if (ctx.dryRun) {
      return dryRunPreview({ results, summary }, { requestId: ctx.requestId, log: ctx.log })
    }

    return ok({ results, summary }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
