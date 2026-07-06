/**
 * /api/v1/companies/{companyId}/invoices/{id}: invoice detail + draft update.
 *
 * GET: full invoice record. ?expand=items,payments controls embedding.
 * PATCH: partial update on DRAFT invoices only. Allowed fields are the
 *         "metadata" subset (dates, references, notes); customer_id,
 *         currency, document_type, and items are immutable: changing any
 *         of those means delete-and-recreate (drafts are cheap). Returns
 *         409 INVOICE_UPDATE_NOT_DRAFT (reusing existing code) if the
 *         invoice is not in draft status.
 *
 *         Idempotent (mandatory Idempotency-Key) and dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { INVOICE_FULL_COLUMNS, INVOICE_ITEM_FULL_COLUMNS } from '@/lib/api/v1/invoice-columns'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'

// Allowed PATCH fields for a draft invoice. Excludes items (separate
// workflow), customer_id / currency / document_type (structural: change
// via delete + recreate), invoice_number (allocated server-side), all
// computed totals, and status (state machine: use action verbs in PR-B-2b).
const V1PatchDraftInvoiceSchema = z.object({
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').optional(),
  delivery_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'), z.null()]).optional(),
  your_reference: z.union([z.string(), z.null()]).optional(),
  our_reference: z.union([z.string(), z.null()]).optional(),
  notes: z.union([z.string(), z.null()]).optional(),
  // Project/cost-centre tagging ({"6":"P001"}): replaces the whole bag.
  // Send {} to clear all tags. Codes are validated against the dimension
  // registry when the invoice posts at :send, not here.
  default_dimensions: DimensionsBagSchema.optional(),
})

// Loose schema: detail responses carry many fields, and pinning the exact
// types in the registry is overkill until Phase 2 PR-B introduces writes
// that reuse the schema for validation.
const InvoiceDetail = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  customer_id: z.string().uuid(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: z.string(),
  document_type: z.string(),
  currency: z.string(),
  total: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
})

const ALLOWED_EXPAND = ['items', 'payments'] as const

// Explicit projections, shared with the create route so create/detail/patch
// responses never drift.
const INVOICE_DETAIL_COLUMNS = INVOICE_FULL_COLUMNS

const CUSTOMER_DETAIL_COLUMNS =
  'id, name, customer_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, default_payment_terms, notes, archived_at, created_at, updated_at'

const INVOICE_ITEM_COLUMNS = INVOICE_ITEM_FULL_COLUMNS

// Payment projection: drops invoice_id (redundant on the parent), user_id,
// company_id (internal scoping).
const INVOICE_PAYMENT_COLUMNS =
  'id, payment_date, amount, currency, exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id, notes, created_at'

registerEndpoint({
  operation: 'invoices.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoices/:id',
  summary: 'Retrieve a single invoice by id.',
  description:
    'Returns the full invoice record with the customer embedded. Pass ?expand=items for line items, ?expand=payments for payment history, or ?expand=items,payments for both.',
  useWhen:
    'You have an invoice id (from a webhook, the list endpoint, or a customer transaction) and need the full record including amounts, dates, status, and the customer details.',
  doNotUseFor:
    'Listing invoices (use GET /api/v1/companies/{companyId}/invoices). Bookkeeping verifikationer tied to the invoice (use the journal-entries endpoints in a later phase).',
  pitfalls: [
    'Returns 404 if the invoice does not belong to the company in the URL: does not leak existence across companies.',
    'paid_at and remaining_amount can lag behind the latest payment by a few seconds during high-volume reconciliation.',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        customer_id: 'a8f1…',
        customer: { id: 'a8f1…', name: 'Acme AB' },
        invoice_date: '2026-05-01',
        due_date: '2026-05-31',
        status: 'sent',
        total: 12500,
        remaining_amount: 12500,
        paid_at: null,
        created_at: '2026-05-01T09:14:33Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(InvoiceDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.get',
  async (request, ctx, params) => {
    const { id } = await params.params

    // Defense in depth: validate the path id is a UUID before touching the
    // database or reflecting it in error details.
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    const url = new URL(request.url)

    const expandResult = parseExpand(url, ALLOWED_EXPAND)
    if (!expandResult.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'expand',
          invalidKeys: expandResult.invalidKeys,
          allowed: expandResult.allowed,
        },
      })
    }
    const expand = expandResult.expand

    const itemsSelect = expand.has('items') ? `, items:invoice_items(${INVOICE_ITEM_COLUMNS})` : ''
    const paymentsSelect = expand.has('payments')
      ? `, payments:invoice_payments(${INVOICE_PAYMENT_COLUMNS})`
      : ''
    const selectClause = `${INVOICE_DETAIL_COLUMNS}, customer:customers(${CUSTOMER_DETAIL_COLUMNS})${itemsSelect}${paymentsSelect}`

    const { data, error } = await ctx.supabase
      .from('invoices')
      .select(selectClause)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    if (!data) {
      // Generic NOT_FOUND: do not echo the queried id back to the caller.
      ctx.log.warn('invoices.get: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: update a DRAFT invoice (metadata fields only)
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'invoices.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/invoices/:id',
  summary: 'Update a draft invoice (metadata fields only).',
  description:
    'Partial update for invoices in draft status. Allowed fields: invoice_date, due_date, delivery_date, your_reference, our_reference, notes, default_dimensions (project/cost-centre tags, e.g. {"6":"P001"}; replaces the whole bag). customer_id, currency, document_type, items, and computed totals are immutable: replace those by deleting the draft and recreating it. Returns 409 INVOICE_UPDATE_NOT_DRAFT if the invoice is no longer in draft status. Idempotent and dry-runnable.',
  useWhen:
    'You need to correct a typo, push the due date, or update a customer reference on a draft you have not sent yet. The invoice number stays null until the first :send action.',
  doNotUseFor:
    'Updating a sent / paid / credited invoice (those are immutable per ML 17 kap; issue a credit note via POST /:id:credit in PR-B-2b). Changing items, currency, or customer: drafts are cheap to delete and recreate.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A 409 INVOICE_UPDATE_NOT_DRAFT means the invoice has been sent / paid / credited / cancelled. The error code name is shared with the DELETE handler.',
    'Items are immutable here: to change line items, delete the draft and POST a fresh one.',
    'default_dimensions replaces the entire bag (no per-key merge): read the current value first if you want to add a tag. Send {} to clear all tags. Codes are validated against the dimension registry at :send, not at PATCH time.',
  ],
  example: {
    request: { due_date: '2026-07-15', notes: 'Förlängd förfallotid' },
    response: {
      data: {
        id: '0e9c…',
        status: 'draft',
        due_date: '2026-07-15',
        notes: 'Förlängd förfallotid',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: V1PatchDraftInvoiceSchema },
  response: { success: dataEnvelope(InvoiceDetail) },
})

const INVOICE_PATCH_RESPONSE_COLUMNS = INVOICE_FULL_COLUMNS

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.update',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = V1PatchDraftInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    const updateData: Record<string, unknown> = {}
    for (const key of [
      'invoice_date',
      'due_date',
      'delivery_date',
      'your_reference',
      'our_reference',
      'notes',
      'default_dimensions',
    ] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }

    if (Object.keys(updateData).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field must be supplied for update.' },
      })
    }

    // Pre-flight: verify the invoice exists in this company AND is still in
    // draft status. We do this for both dry-run and commit so the response
    // is consistent: dry-run that "succeeds" on a non-draft would mislead.
    const { data: current, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(INVOICE_PATCH_RESPONSE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!current) {
      ctx.log.warn('invoices.update: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }
    if ((current as { status: string }).status !== 'draft') {
      return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (current as { status: string }).status },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview({ ...current, ...updateData }, { requestId: ctx.requestId, log: ctx.log })
    }

    const { data, error } = await ctx.supabase
      .from('invoices')
      .update({ ...updateData, updated_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .eq('status', 'draft') // Belt + braces: race condition guard.
      .select(INVOICE_PATCH_RESPONSE_COLUMNS)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      // Race: the invoice transitioned out of draft between the pre-flight
      // and the update. Treat as the same 409 as the pre-flight check.
      return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'Invoice transitioned out of draft during update.' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
