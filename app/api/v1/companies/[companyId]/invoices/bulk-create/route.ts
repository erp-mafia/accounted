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
import { getPermittedVatRates, getVatRules } from '@/lib/invoices/vat-rules'
import { convertToSEK, fetchExchangeRate } from '@/lib/currency/riksbanken'
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
    'Each per-item invoice still goes through the same VAT-rule validation as POST /invoices. A mismatched per-item vat_rate produces a per-item failure, not a whole-batch failure.',
    'Currency conversion is best-effort PER ITEM. A failed Riksbanken fetch leaves that item\'s SEK columns null but does NOT fail the item.',
    'Quotes (document_type: quote) are refused per item as VALIDATION_ERROR: a quote carries its own OF-number, valid_until and quote_status. Create quotes one at a time with POST /invoices.',
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
}

/**
 * Create one invoice (the bulk-create item path). Mirrors the inline logic
 * in POST /invoices/route.ts. Returns a ResultItem instead of an HTTP
 * response so the caller can aggregate.
 *
 * TODO: extract POST /invoices's create logic into a shared lib function
 * so this and the per-call POST share one implementation. Tracked as
 * cross-route cleanup.
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

  // Customer fetch (scoped to company). We use the DB-returned `customer.id`
  // (not `input.customer_id`) downstream as defense in depth: the .eq()
  // pair already enforces company scoping, but echoing the trusted value
  // from the query makes the guarantee explicit at the call site and
  // immune to refactoring drift.
  const { data: customer } = await supabase
    .from('customers')
    .select('id, customer_type, vat_number_validated, country')
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
  const verifiedCustomerId = (customer as { id: string }).id

  const vatRules = getVatRules(
    customer.customer_type as Parameters<typeof getVatRules>[0],
    customer.vat_number_validated,
    customer.country,
  )
  // Gate on the PERMITTED set, not the picker default, exactly like
  // buildInvoiceWriteData: the ML 6 kap. supplies taxed where they are performed
  // (hotel/restaurang 12%, persontransport and event admission 6%,
  // fastighetstjänst and korttidsuthyrning 25%) carry Swedish VAT even to a
  // foreign business customer. The default is still 0% (vatRules.rate is the
  // fallback below), so a Swedish rate only lands here when sent explicitly.
  const permittedRates = getPermittedVatRates(
    customer.customer_type as Parameters<typeof getPermittedVatRates>[0],
    customer.vat_number_validated,
    customer.country,
  )
  const allowedRates = new Set(permittedRates.map((r) => r.rate))

  // VAT registration gate, mirroring buildInvoiceWriteData (issue #1719): a
  // non-momsregistrerad company books no output VAT, so every line is forced
  // to 0% (momsfri) server-side no matter what the batch payload carries,
  // explicitly or via the customer-default fallback below. 0% is a permitted
  // rate for every customer type, so the allowedRates gate still passes.
  const { data: vatSettings } = await supabase
    .from('company_settings')
    .select('vat_registered')
    .eq('company_id', companyId)
    .maybeSingle()
  const notVatRegistered = vatSettings?.vat_registered === false
  if (notVatRegistered && documentType !== 'delivery_note') {
    for (const item of input.items) item.vat_rate = 0
  }

  const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
  let vatAmount = 0
  if (documentType !== 'delivery_note') {
    for (const item of input.items) {
      const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
      if (!allowedRates.has(itemRate)) {
        return {
          ok: false,
          request_index: index,
          error: {
            code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
            message: 'A line item carries a VAT rate not allowed for the customer type.',
            details: {
              attempted_rate: itemRate,
              allowed_rates: Array.from(allowedRates),
              customer_type: customer.customer_type,
            },
          },
        }
      }
      const lineTotal = item.quantity * item.unit_price
      vatAmount += Math.round((lineTotal * itemRate) / 100 * 100) / 100
    }
  }
  const total = documentType === 'delivery_note' ? 0 : subtotal + vatAmount
  const uniqueRates = new Set(input.items.map((it) => it.vat_rate ?? vatRules.rate))
  const isMixedRate = uniqueRates.size > 1
  const headerVatRate = documentType === 'delivery_note'
    ? 0
    : isMixedRate
      ? null
      : (uniqueRates.values().next().value ?? vatRules.rate)

  // Currency conversion (best-effort per item).
  let exchangeRate: number | null = null
  let exchangeRateDate: string | null = null
  let subtotalSek: number | null = null
  let vatAmountSek: number | null = null
  let totalSek: number | null = null
  if (input.currency !== 'SEK') {
    try {
      const rate = await fetchExchangeRate(input.currency)
      if (rate) {
        exchangeRate = rate.rate
        exchangeRateDate = rate.date
        subtotalSek = convertToSEK(subtotal, exchangeRate)
        vatAmountSek = convertToSEK(vatAmount, exchangeRate)
        totalSek = convertToSEK(total, exchangeRate)
      }
    } catch (err) {
      log.warn('bulk-create: exchange-rate fetch failed for item', err as Error, {
        request_index: index,
        currency: input.currency,
      })
    }
  }

  const itemRows = input.items.map((item, sortOrder) => {
    const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    const lineTotal = item.quantity * item.unit_price
    const itemVat = documentType === 'delivery_note'
      ? 0
      : Math.round((lineTotal * itemRate) / 100 * 100) / 100
    return {
      sort_order: sortOrder,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: lineTotal,
      vat_rate: itemRate,
      vat_amount: itemVat,
      // Dimensions PR7: per-item bag, merged over the invoice's
      // default_dimensions on the revenue line when the JE posts at :send.
      dimensions: item.dimensions ?? {},
    }
  })

  if (dryRun) {
    return {
      ok: true,
      request_index: index,
      data: {
        preview: {
          invoice_number: null,
          customer_id: verifiedCustomerId,
          invoice_date: input.invoice_date,
          due_date: input.due_date,
          status: 'draft' as const,
          currency: input.currency,
          subtotal: documentType === 'delivery_note' ? 0 : subtotal,
          vat_amount: vatAmount,
          total,
          document_type: documentType,
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
      customer_id: verifiedCustomerId,
      invoice_number: null,
      invoice_date: input.invoice_date,
      due_date: input.due_date,
      delivery_date: input.delivery_date ?? null,
      currency: input.currency,
      exchange_rate: exchangeRate,
      exchange_rate_date: exchangeRateDate,
      subtotal: documentType === 'delivery_note' ? 0 : subtotal,
      subtotal_sek: documentType === 'delivery_note' ? null : subtotalSek,
      vat_amount: vatAmount,
      vat_amount_sek: documentType === 'delivery_note' ? null : vatAmountSek,
      total,
      total_sek: documentType === 'delivery_note' ? null : totalSek,
      remaining_amount: documentType === 'invoice' ? total : 0,
      // Header VAT fields mirror buildInvoiceWriteData: a not-VAT-registered
      // company stamps the sale as momsfri (treatment 'exempt', no ruta, no
      // reverse-charge notation); every line rate is already zeroed above.
      vat_treatment: notVatRegistered ? 'exempt' : vatRules.treatment,
      vat_rate: headerVatRate,
      moms_ruta: notVatRegistered ? null : vatRules.momsRuta,
      reverse_charge_text: notVatRegistered ? null : (vatRules.reverseChargeText || null),
      your_reference: input.your_reference,
      our_reference: input.our_reference,
      notes: input.notes,
      document_type: documentType,
      // Dimensions PR7: invoice-level bag; the :send JE generator applies it
      // to every line (items[].dimensions win per key).
      default_dimensions: input.default_dimensions ?? {},
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

  return { ok: true, request_index: index, data: invoice }
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
      const item = await createOneInvoice(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        i,
        body.invoices[i],
        ctx.dryRun,
        ctx.log,
      )
      results.push(item)
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
