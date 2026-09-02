/**
 * /api/v1/companies/{companyId}/invoices/{id}: invoice detail + draft update.
 *
 * GET: full invoice record. ?expand=items,payments controls embedding.
 * PATCH: partial update on DRAFT invoices only. Allowed fields are the
 *         "metadata" subset (dates, references, notes, default_dimensions)
 *         plus an OPTIONAL `items` array: when present, it fully REPLACES
 *         the draft's line items and totals/VAT are recomputed via the
 *         shared buildInvoiceWriteData against the invoice's EXISTING
 *         customer; when omitted, items are untouched. customer_id,
 *         currency, and document_type remain immutable: changing those
 *         means delete-and-recreate (drafts are cheap). Returns
 *         409 INVOICE_UPDATE_NOT_DRAFT (reusing existing code) if the
 *         invoice is not in draft status.
 *
 *         Idempotent (mandatory Idempotency-Key) and dry-runnable.
 * DELETE: remove a DRAFT invoice. Unnumbered drafts are hard deleted (no
 *         F-series number was consumed, so no gap arises); numbered drafts
 *         are makulerade (status flips to 'cancelled', the number is
 *         retained so the F-series stays gap-free). Non-drafts return 409
 *         INVOICE_DELETE_NOT_DRAFT: sent / paid invoices are immutable and
 *         must be reversed via POST /:id/credit instead.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { INVOICE_FULL_COLUMNS, INVOICE_ITEM_FULL_COLUMNS } from '@/lib/api/v1/invoice-columns'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'
import { CreateInvoiceItemSchema } from '@/lib/api/schemas'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import { deleteDraftInvoice } from '@/lib/invoices/delete-draft-invoice'
import { replaceInvoiceItems } from '@/lib/invoices/replace-invoice-items'
import type { Currency, Customer, InvoiceDocumentType } from '@/types'

// Allowed PATCH fields for a draft invoice. Excludes customer_id / currency /
// document_type (structural: change via delete + recreate), invoice_number
// (allocated server-side), all computed totals, and status (state machine:
// use action verbs in PR-B-2b). `items` is OPTIONAL: when present it fully
// replaces the line set (delete + reinsert, totals recomputed); when omitted
// the items are unchanged. Note this differs from the cookie route, where
// items is required: a v1 metadata-only PATCH must keep working without it.
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
  // FULL REPLACE when present. Same item shape as POST /invoices (article
  // linkage, ROT/RUT lines, accrual periods, per-line dimensions included).
  items: z.array(CreateInvoiceItemSchema).min(1, 'At least one item is required').optional(),
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
  summary: 'Update a draft invoice (metadata fields, optionally replacing line items).',
  description:
    'Partial update for invoices in draft status. Allowed fields: invoice_date, due_date, delivery_date, your_reference, our_reference, notes, default_dimensions (project/cost-centre tags, e.g. {"6":"P001"}; replaces the whole bag), and an optional items array. When items is present, it fully REPLACES the draft\'s line items and subtotal / VAT / total are recomputed against the invoice\'s existing customer (same validation as POST /invoices); when omitted, items and totals are unchanged. customer_id, currency, and document_type are immutable: replace those by deleting the draft and recreating it. Returns 409 INVOICE_UPDATE_NOT_DRAFT if the invoice is no longer in draft status. Idempotent and dry-runnable.',
  useWhen:
    'You need to correct a typo, push the due date, update a customer reference, or rewrite the line items on a draft you have not sent yet. The invoice number stays null until the first :send action.',
  doNotUseFor:
    'Updating a sent / paid / credited invoice (those are immutable per ML 17 kap; issue a credit note via POST /:id:credit in PR-B-2b). Changing currency or customer: drafts are cheap to delete and recreate.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A 409 INVOICE_UPDATE_NOT_DRAFT means the invoice has been sent / paid / credited / cancelled. The DELETE handler on this path uses its own code, INVOICE_DELETE_NOT_DRAFT.',
    'items is a FULL REPLACE (no per-line merge): send the complete new line set, minimum one item. Omitting items keeps the current lines untouched. VAT rates are re-validated against the customer type and totals are recomputed server-side.',
    'items are always built against the invoice\'s EXISTING customer: customer_id cannot change on PATCH.',
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

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = V1PatchDraftInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
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

    if (Object.keys(updateData).length === 0 && !body.items) {
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

    // ── Items replacement path ────────────────────────────────────────
    // Full replace + recompute via the shared write-builder (the same one
    // POST /invoices and the cookie PATCH route use), built against the
    // invoice's EXISTING customer: customer_id is immutable on PATCH.
    if (body.items) {
      const cur = current as Record<string, unknown>

      // Internal-only columns for the rebuild. Fetched separately so the
      // response/preview projection (INVOICE_PATCH_RESPONSE_COLUMNS) can
      // never leak the encrypted personnummer blob.
      const { data: internal, error: internalErr } = await ctx.supabase
        .from('invoices')
        .select('ore_rounding, deduction_personnummer_encrypted, deduction_personnummer_last4')
        .eq('company_id', ctx.companyId!)
        .eq('id', invoiceId)
        .maybeSingle()
      if (internalErr) {
        return v1ErrorResponse(internalErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!internal) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'invoice' },
        })
      }
      const internalCols = internal as {
        ore_rounding: boolean | null
        deduction_personnummer_encrypted: string | null
        deduction_personnummer_last4: string | null
      }

      // The builder only reads customer_type + vat_number_validated: narrow
      // projection keeps customer PII out of this path.
      const { data: customer, error: customerErr } = await ctx.supabase
        .from('customers')
        .select('id, customer_type, vat_number_validated')
        .eq('company_id', ctx.companyId!)
        .eq('id', cur.customer_id as string)
        .maybeSingle()
      if (customerErr) {
        return v1ErrorResponse(customerErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!customer) {
        return v1ErrorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'customer' },
        })
      }

      // ROT/RUT claim info lives per line, not on the header: surface the
      // first deduction line's values as the invoice-level inputs the
      // builder's presence checks expect (per-line values win regardless).
      const firstDeduction = body.items.find((item) => item.deduction_type)

      const build = await buildInvoiceWriteData({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        customer: customer as unknown as Customer,
        documentType: ((cur.document_type as string) || 'invoice') as InvoiceDocumentType,
        input: {
          customer_id: cur.customer_id as string,
          invoice_date: (body.invoice_date ?? cur.invoice_date) as string,
          due_date: (body.due_date ?? cur.due_date) as string,
          delivery_date:
            body.delivery_date !== undefined
              ? body.delivery_date
              : (cur.delivery_date as string | null),
          currency: cur.currency as Currency,
          your_reference:
            (body.your_reference !== undefined ? body.your_reference : (cur.your_reference as string | null)) ??
            undefined,
          our_reference:
            (body.our_reference !== undefined ? body.our_reference : (cur.our_reference as string | null)) ??
            undefined,
          notes: (body.notes !== undefined ? body.notes : (cur.notes as string | null)) ?? undefined,
          // Not editable on this surface: fed back so the builder echoes the
          // stored values instead of clearing them.
          payment_link_url: (cur.payment_link_url as string | null) ?? undefined,
          payment_link_auto: (cur.payment_link_auto as boolean | null) ?? undefined,
          ore_rounding: internalCols.ore_rounding ?? undefined,
          deduction_housing_designation: firstDeduction?.housing_designation ?? undefined,
          deduction_apartment_number: firstDeduction?.apartment_number ?? undefined,
          deduction_brf_org_number: firstDeduction?.brf_org_number ?? undefined,
          default_dimensions:
            body.default_dimensions ??
            ((cur.default_dimensions as Record<string, string> | null) ?? {}),
          items: body.items,
        },
        // The stored personnummer exists only as ciphertext: a replace that
        // still carries deduction lines keeps the stored value.
        existingPersonnummer: internalCols.deduction_personnummer_encrypted
          ? {
              encrypted: internalCols.deduction_personnummer_encrypted,
              last4: internalCols.deduction_personnummer_last4,
            }
          : null,
      })
      if (!build.ok) {
        if ('dbError' in build) {
          return v1ErrorResponse(build.dbError, ctx.log, { requestId: ctx.requestId })
        }
        // Same snake_case wire mapping as POST /invoices for this code.
        const details =
          build.code === 'INVOICE_CREATE_VAT_RULE_VIOLATION' && build.details
            ? {
                attempted_rate: build.details.attemptedRate,
                allowed_rates: build.details.allowedRates,
                customer_type: build.details.customerType,
              }
            : build.details
        return v1ErrorResponseFromCode(build.code, ctx.log, {
          requestId: ctx.requestId,
          details,
        })
      }

      // Never echo the encrypted personnummer blob in a preview.
      const { deduction_personnummer_encrypted: _omit, ...previewFields } = build.invoiceFields

      if (ctx.dryRun) {
        return dryRunPreview(
          { ...current, ...previewFields, ...updateData, items: build.items },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }

      // Computed fields from the builder; explicitly-sent metadata (incl.
      // nulls that clear a column) wins on top. invoice_number and status
      // stay untouched; the status guard turns a concurrent send into a
      // 0-row update instead of rewriting a now-issued invoice.
      const { data: updatedRow, error: updateErr } = await ctx.supabase
        .from('invoices')
        .update({ ...build.invoiceFields, ...updateData, updated_at: new Date().toISOString() })
        .eq('company_id', ctx.companyId!)
        .eq('id', invoiceId)
        .eq('status', 'draft')
        .select(INVOICE_PATCH_RESPONSE_COLUMNS)
        .maybeSingle()

      if (updateErr) {
        return v1ErrorResponse(updateErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!updatedRow) {
        return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: 'Invoice transitioned out of draft during update.' },
        })
      }

      // Full replace via the shared helper (same delete + reinsert as the
      // cookie route and the update_invoice commit executor).
      const replaced = await replaceInvoiceItems(ctx.supabase, invoiceId, build.items)
      if (!replaced.ok) {
        if (replaced.stage === 'guard') {
          return v1ErrorResponseFromCode(replaced.code, ctx.log, { requestId: ctx.requestId })
        }
        ctx.log.error(`invoice items ${replaced.stage} failed on v1 update`, replaced.error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        return v1ErrorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { stage: replaced.stage, pg_code: replaced.error.code },
        })
      }

      // Refetch with items so the caller sees the replaced line set.
      const { data: complete, error: refetchErr } = await ctx.supabase
        .from('invoices')
        .select(`${INVOICE_PATCH_RESPONSE_COLUMNS}, items:invoice_items(${INVOICE_ITEM_COLUMNS})`)
        .eq('company_id', ctx.companyId!)
        .eq('id', invoiceId)
        .maybeSingle()

      if (refetchErr || !complete) {
        ctx.log.warn('invoice refetch after items update failed; returning header without items', {
          invoiceId,
          pgCode: (refetchErr as { code?: string } | null)?.code,
        })
        return ok(updatedRow, { requestId: ctx.requestId })
      }

      return ok(complete, { requestId: ctx.requestId })
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

// ──────────────────────────────────────────────────────────────────
// DELETE: remove a DRAFT invoice (hard delete or makulering)
// ──────────────────────────────────────────────────────────────────

const InvoiceDeleteResult = z.object({
  // Unnumbered draft: hard deleted.
  deleted: z.boolean().optional(),
  // Numbered draft: makulerad; the F-series number is retained.
  cancelled: z.boolean().optional(),
  invoice_number: z.string().optional(),
})

registerEndpoint({
  operation: 'invoices.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/invoices/:id',
  summary: 'Delete a draft invoice (hard delete if unnumbered, makulering if numbered).',
  description:
    'Removes an invoice in draft status. An unnumbered draft (never finalized: no F-series number was consumed) is hard deleted and responds { deleted: true }; its line items cascade. A numbered draft is makulerad: the row and its number are retained, status flips to cancelled, and the response is { cancelled: true, invoice_number } so the F-series stays gap-free per ML 17 kap 24 and BFNAR 2013:2. Returns 409 INVOICE_DELETE_NOT_DRAFT for any non-draft status: sent / paid / credited invoices are immutable and must be reversed via a credit note. Requires Idempotency-Key; dry-runnable.',
  useWhen:
    'You created a draft by mistake, or want to discard a draft instead of sending it. Check the response shape: deleted means the row is gone, cancelled means it survives as makulerad with its number.',
  doNotUseFor:
    'Withdrawing a sent / paid invoice (issue a credit note via POST /:id/credit). Editing a draft (use PATCH). Cancelling recurring schedules.',
  pitfalls: [
    'Idempotency-Key is mandatory. A repeated DELETE with a fresh key returns 404 for a hard-deleted draft (the row is gone) and 409 INVOICE_DELETE_NOT_DRAFT for a makulerad one (status is now cancelled).',
    '409 INVOICE_DELETE_NOT_DRAFT means the invoice left draft status: it is immutable and can only be reversed via a credit note.',
    '409 INVOICE_CANCEL_RACE means the invoice was finalized or sent concurrently: re-read the invoice before retrying.',
    'The hard-delete path emits an invoice.draft_deleted audit event; the makulering path leaves its trail in the invoice row itself.',
  ],
  example: {
    response: {
      data: { cancelled: true, invoice_number: '2026-0042' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  // 'high', matching the delete_draft_invoice pending-op tier: both outcomes
  // are irreversible (row gone, or the F-series number permanently consumed).
  risk: 'high',
  idempotent: false,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(InvoiceDeleteResult) },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    // Dry-run: pre-flight the same guards without writing, and report which
    // of the two outcomes the commit would take.
    if (ctx.dryRun) {
      const { data: current, error: fetchErr } = await ctx.supabase
        .from('invoices')
        .select('id, status, invoice_number')
        .eq('company_id', ctx.companyId!)
        .eq('id', invoiceId)
        .maybeSingle()

      if (fetchErr) {
        return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!current) {
        ctx.log.warn('invoices.delete: not found', { invoiceId, companyId: ctx.companyId })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'invoice' },
        })
      }
      if (current.status !== 'draft') {
        return v1ErrorResponseFromCode('INVOICE_DELETE_NOT_DRAFT', ctx.log, {
          requestId: ctx.requestId,
          status: 409,
          details: { current_status: current.status },
        })
      }
      return dryRunPreview(
        current.invoice_number
          ? { cancelled: true, invoice_number: current.invoice_number }
          : { deleted: true },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const result = await deleteDraftInvoice({
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      // Explicit actor: the service-role client nulls auth.uid(), so the
      // audit event's userId must come from the API-key context.
      userId: ctx.userId,
      invoiceId,
      log: ctx.log,
    })

    if (!result.ok) {
      switch (result.code) {
        case 'INVOICE_NOT_FOUND':
          // Generic NOT_FOUND: same shape as GET, no existence leak.
          ctx.log.warn('invoices.delete: not found', { invoiceId, companyId: ctx.companyId })
          return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
            requestId: ctx.requestId,
            details: { resource: 'invoice' },
          })
        case 'INVOICE_DELETE_NOT_DRAFT':
          // Registry maps this code to 400 for the cookie route; on v1 a
          // state-machine refusal is a conflict, aligned with
          // INVOICE_UPDATE_NOT_DRAFT.
          return v1ErrorResponseFromCode('INVOICE_DELETE_NOT_DRAFT', ctx.log, {
            requestId: ctx.requestId,
            status: 409,
            details: { current_status: result.currentStatus },
          })
        case 'INVOICE_CANCEL_RACE':
          return v1ErrorResponseFromCode('INVOICE_CANCEL_RACE', ctx.log, {
            requestId: ctx.requestId,
          })
        case 'INVOICE_DELETE_FAILED':
          return v1ErrorResponseFromCode('INVOICE_DELETE_FAILED', ctx.log, {
            requestId: ctx.requestId,
            details: { pg_code: result.cause.code },
          })
      }
    }

    if (result.outcome === 'deleted') {
      return ok({ deleted: true }, { requestId: ctx.requestId })
    }
    return ok({ cancelled: true, invoice_number: result.invoiceNumber }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
