/**
 * /api/v1/companies/{companyId}/customers/{id}: customer detail + writes.
 *
 * GET   : full record. ?expand=invoices embeds open invoices.
 * PATCH : partial update. Idempotent (mandatory Idempotency-Key).
 *          Dry-runnable. VIES re-validation on commit if vat_number changes.
 *          Setting archived_at: null un-archives the customer.
 * DELETE: soft-delete (sets archived_at). Idempotent. Dry-runnable. 204
 *          on success. REFUSES to archive when the customer has any open
 *          (sent / partially_paid / overdue) invoice: preserves the
 *          canonical buyer name/address that ML 17 kap 24§ requires the
 *          invoice to carry. Issue a kreditfaktura first if needed.
 */

import { z } from 'zod'
import { noContent, ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { UpdateCustomerSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'

// v1-only extension: allow PATCH to set archived_at back to null to
// un-archive a customer. Restricted to literal `null` so the caller can't
// fake an archive timestamp.
const V1PatchCustomerSchema = UpdateCustomerSchema.extend({
  archived_at: z.null().optional(),
})

const CustomerDetail = z.object({
  id: z.string().uuid(),
  name: z.string(),
  customer_type: z.string(),
  customer_number: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  vat_number_validated: z.boolean(),
  default_payment_terms: z.number(),
  notes: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const ALLOWED_EXPAND = ['invoices'] as const
const OPEN_INVOICE_STATUSES = ['sent', 'partially_paid', 'overdue']

// Explicit projection. Excludes user_id, company_id (internal scoping),
// and vat_number_validated_at (internal timestamp not in the public schema).
const CUSTOMER_DETAIL_COLUMNS =
  'id, name, customer_type, customer_number, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, default_payment_terms, notes, archived_at, created_at, updated_at'

const OPEN_INVOICE_COLUMNS =
  'id, invoice_number, invoice_date, due_date, status, currency, total, remaining_amount'

registerEndpoint({
  operation: 'customers.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Retrieve a single customer by id.',
  description:
    'Returns the full customer record. Pass ?expand=invoices to embed any open invoices (sent / partially_paid / overdue) for the customer in the same response.',
  useWhen:
    'You need the full customer record: address, payment terms, VAT validation status, contact details: before invoicing or syncing to another system.',
  doNotUseFor:
    'Listing customers (use the list endpoint). Looking up arbitrary supplier or employee records (different resources).',
  pitfalls: [
    'archived_at is non-null when the customer has been soft-deleted; the customer is still queryable by id but excluded from default lists.',
    'vat_number_validated reflects the last successful VIES check; it can become stale if the EU registry revokes a number.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        name: 'Acme AB',
        customer_type: 'business',
        email: 'finance@acme.example',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vat_number_validated: true,
        country: 'Sweden',
        default_payment_terms: 30,
        archived_at: null,
        created_at: '2025-04-12T08:30:00Z',
        updated_at: '2026-04-30T11:22:09Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(CustomerDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.get',
  async (request, ctx, params) => {
    const { id } = await params.params

    // Defense in depth: validate the path id is a UUID before touching the
    // database or reflecting it in error details.
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }
    const customerId = idParse.data

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

    const { data: customer, error } = await ctx.supabase
      .from('customers')
      .select(CUSTOMER_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', customerId)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!customer) {
      // Generic NOT_FOUND: do not echo the queried id back to the caller
      // (enumeration hardening).
      ctx.log.warn('customers.get: not found', { customerId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    // Open invoices expansion: separate query to avoid bloating the
    // customer base shape with a join that's only sometimes needed.
    let invoices: unknown[] | undefined
    const partialExpansions: string[] = []
    if (expand.has('invoices')) {
      const { data: invs, error: invErr } = await ctx.supabase
        .from('invoices')
        .select(OPEN_INVOICE_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('customer_id', customerId)
        .in('status', OPEN_INVOICE_STATUSES)
        .order('invoice_date', { ascending: false })

      if (invErr) {
        // Soft-degrade: log but still return the customer. The agent gets
        // the primary resource; ?expand is a hint, not a guarantee.
        // `meta.partial_expansions` signals which expansions failed so
        // careful callers can retry or fall back without parsing the body.
        const errMsg = (invErr as { code?: string; message?: string }).message ?? 'unknown'
        const errCode = (invErr as { code?: string }).code ?? 'unknown'
        // Postgres error class 42 = "Syntax Error or Access Rule Violation"
        // (includes 42501 insufficient_privilege). These indicate a real
        // misconfiguration: a revoked grant or an incorrect RLS policy:
        // and should reach Sentry/error monitoring rather than blending
        // into informational warn logs. Other classes are typically
        // transient (network, timeout) and stay at warn.
        const isPermissionError = typeof errCode === 'string' && errCode.startsWith('42')
        if (isPermissionError) {
          ctx.log.error('customers.get: open-invoices expansion permission denied', new Error(errMsg), {
            errCode,
            customerId,
          })
        } else {
          ctx.log.warn('customers.get: open-invoices expansion failed', { errCode, errMsg })
        }
        invoices = []
        partialExpansions.push('invoices')
      } else {
        invoices = invs ?? []
      }
    }

    return ok(
      { ...customer, ...(invoices !== undefined ? { invoices } : {}) },
      {
        requestId: ctx.requestId,
        partialExpansions: partialExpansions.length > 0 ? partialExpansions : undefined,
      },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: partial update
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'customers.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Partially update a customer.',
  description:
    'Patches the customer with the supplied fields. All fields optional. Idempotent (mandatory Idempotency-Key). Dry-runnable. When vat_number changes on an eu_business customer, VIES re-validation runs on commit (best-effort).',
  useWhen:
    'You need to change a customer\'s contact details, payment terms, address, or VAT registration. Use dry-run first to confirm the merged record before committing.',
  doNotUseFor:
    'Archiving a customer (use DELETE: sets archived_at). Replacing the entire record (no PUT verb is exposed; PATCH is partial).',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'org_number uniqueness is enforced at DB level: 23505 → 409 CUSTOMER_DUPLICATE_ORG_NUMBER.',
    'VIES re-validation is best-effort and runs only on commit. A VIES timeout does not fail the update.',
  ],
  example: {
    request: { default_payment_terms: 14, notes: 'New payment terms agreed 2026-05-12.' },
    response: {
      data: {
        id: '0e9c…',
        name: 'Acme AB',
        default_payment_terms: 14,
        notes: 'New payment terms agreed 2026-05-12.',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateCustomerSchema },
  response: { success: dataEnvelope(CustomerDetail) },
})

const CUSTOMER_UPDATE_RESPONSE_COLUMNS = CUSTOMER_DETAIL_COLUMNS

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.update',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }
    const customerId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = V1PatchCustomerSchema.safeParse(rawBody)
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

    // Build the partial update set. Fields explicitly set to undefined in
    // the body are not in the resulting object (Zod strips undefined). null
    // IS allowed and means "clear the field" (or, for archived_at, "un-archive").
    const updateData: Record<string, unknown> = {}
    for (const key of [
      'name',
      'customer_type',
      'email',
      'phone',
      'address_line1',
      'address_line2',
      'postal_code',
      'city',
      'country',
      'org_number',
      'vat_number',
      'language',
      'default_payment_terms',
      'notes',
      'archived_at',
    ] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }
    // Empty string clears the customer number, same as an explicit null
    // (matches the internal /api/customers route).
    if (body.customer_number !== undefined) {
      updateData.customer_number = body.customer_number || null
    }

    if (Object.keys(updateData).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field must be supplied for update.' },
      })
    }

    // Dry-run: fetch the current record, merge with the proposed changes,
    // return the merged preview. No DB write.
    if (ctx.dryRun) {
      const { data: current, error: fetchErr } = await ctx.supabase
        .from('customers')
        .select(CUSTOMER_DETAIL_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('id', customerId)
        .maybeSingle()

      if (fetchErr) {
        return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!current) {
        ctx.log.warn('customers.update dry-run: not found', { customerId, companyId: ctx.companyId })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'customer' },
        })
      }

      return dryRunPreview({ ...current, ...updateData }, { requestId: ctx.requestId, log: ctx.log })
    }

    // Best-effort VIES re-validation if vat_number is changing on an
    // eu_business customer. Resolve BEFORE the update so the result lands
    // atomically with the rest of the change: the API response is then
    // guaranteed to reflect committed DB state, not a stale value from a
    // separate fire-and-forget update.
    if (body.vat_number !== undefined) {
      const wouldBeType =
        body.customer_type ??
        // Need the existing type if the caller didn't change it.
        (
          await ctx.supabase
            .from('customers')
            .select('customer_type')
            .eq('company_id', ctx.companyId!)
            .eq('id', customerId)
            .maybeSingle()
        ).data?.customer_type
      if (wouldBeType === 'eu_business') {
        if (body.vat_number) {
          try {
            const vatResult = await validateVatNumber(body.vat_number)
            updateData.vat_number_validated = vatResult.valid
            updateData.vat_number_validated_at = vatResult.valid ? new Date().toISOString() : null
          } catch (err) {
            ctx.log.warn('auto-VIES re-validation failed on customer update', err as Error)
            updateData.vat_number_validated = false
            updateData.vat_number_validated_at = null
          }
        } else {
          // vat_number cleared
          updateData.vat_number_validated = false
          updateData.vat_number_validated_at = null
        }
      }
    }

    const { data, error } = await ctx.supabase
      .from('customers')
      .update(updateData)
      .eq('company_id', ctx.companyId!)
      .eq('id', customerId)
      .select(CUSTOMER_UPDATE_RESPONSE_COLUMNS)
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        // GDPR Art.5(1)(c): do NOT echo body.org_number: for
        // customer_type='individual' it IS the personnummer.
        return v1ErrorResponseFromCode('CUSTOMER_DUPLICATE_ORG_NUMBER', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'org_number' },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('customers.update: not found', { customerId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: soft-delete (sets archived_at)
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'customers.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Archive a customer (soft-delete).',
  description:
    'Sets archived_at on the customer; the record is preserved (invoices and audit history remain intact) but excluded from default list responses. To un-archive, PATCH archived_at back to null. Idempotent: archiving an already-archived customer is a no-op. Dry-runnable.',
  useWhen:
    'You want to remove a customer from active rosters without losing their history. Idempotent: re-archiving is safe.',
  doNotUseFor:
    'Permanently deleting a customer with all history: the public API does not expose hard-delete. GDPR erasure requests go through a dedicated workflow.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A customer with any open invoice (sent / partially_paid / overdue) cannot be archived: returns 409 CUSTOMER_HAS_INVOICES. Issue a kreditfaktura first if you need to close the relationship cleanly. This protects ML 17 kap 24§: the customer record is the canonical source of buyer name/address for invoice reissuance.',
    '204 No Content is returned on success: there is no response body to parse.',
  ],
  example: {
    response: { data: null, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'customers:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }
    const customerId = idParse.data

    // Pre-flight: check for open invoices BEFORE archiving. Preserves the
    // canonical buyer record per ML 17 kap 24§: an open invoice points at
    // this customer for its statutory name/address fields.
    const { count: openInvoiceCount, error: openErr } = await ctx.supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId!)
      .eq('customer_id', customerId)
      .in('status', OPEN_INVOICE_STATUSES)

    if (openErr) {
      return v1ErrorResponse(openErr, ctx.log, { requestId: ctx.requestId })
    }
    if ((openInvoiceCount ?? 0) > 0) {
      return v1ErrorResponseFromCode('CUSTOMER_HAS_INVOICES', ctx.log, {
        requestId: ctx.requestId,
        details: { open_invoice_count: openInvoiceCount },
      })
    }

    // Dry-run: confirm the customer exists. No state change.
    if (ctx.dryRun) {
      const { data: current, error: fetchErr } = await ctx.supabase
        .from('customers')
        .select(CUSTOMER_DETAIL_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('id', customerId)
        .maybeSingle()

      if (fetchErr) {
        return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!current) {
        ctx.log.warn('customers.delete dry-run: not found', { customerId, companyId: ctx.companyId })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'customer' },
        })
      }

      return dryRunPreview(
        { ...current, archived_at: new Date().toISOString() },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('customers')
      .update({ archived_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', customerId)
      .select('id')
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('customers.delete: not found', { customerId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    return noContent({ requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
