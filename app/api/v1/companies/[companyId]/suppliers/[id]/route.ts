/**
 * /api/v1/companies/{companyId}/suppliers/{id}: supplier detail + writes.
 *
 * GET   : full record. ?expand=supplier_invoices embeds open supplier invoices.
 * PATCH : partial update. Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *          Setting archived_at: null un-archives the supplier.
 * DELETE: soft-delete (sets archived_at). Idempotent. Dry-runnable. 204 on
 *          success. REFUSES to archive when the supplier has any open
 *          (registered / approved / partially_paid / overdue / disputed)
 *          supplier invoice: preserves the canonical seller name/address
 *          that BFL 7 kap requires the leverantörsfaktura to carry. Close
 *          (credit or mark paid) the open invoices first.
 */

import { z } from 'zod'
import { noContent, ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { UpdateSupplierSchema } from '@/lib/api/schemas'

// v1-only extension: allow PATCH to set archived_at back to null to
// un-archive a supplier. Restricted to literal `null` so the caller can't
// fake an archive timestamp.
const V1PatchSupplierSchema = UpdateSupplierSchema.extend({
  archived_at: z.null().optional(),
})

const SupplierDetail = z.object({
  id: z.string().uuid(),
  name: z.string(),
  supplier_type: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  bank_account: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  default_expense_account: z.string().nullable(),
  default_payment_terms: z.number(),
  default_currency: z.string(),
  notes: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const ALLOWED_EXPAND = ['supplier_invoices'] as const
// `disputed` is included so a held supplier invoice still blocks archive:
// the seller record may still be needed if the dispute resolves into a
// kreditfaktura or partial payment.
const OPEN_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'partially_paid',
  'overdue',
  'disputed',
]

const SUPPLIER_DETAIL_COLUMNS =
  'id, name, supplier_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, bankgiro, plusgiro, bank_account, iban, bic, default_expense_account, default_payment_terms, default_currency, notes, archived_at, created_at, updated_at'

const OPEN_SUPPLIER_INVOICE_COLUMNS =
  'id, supplier_invoice_number, arrival_number, invoice_date, due_date, status, currency, total, remaining_amount'

registerEndpoint({
  operation: 'suppliers.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/suppliers/:id',
  summary: 'Retrieve a single supplier by id.',
  description:
    'Returns the full supplier record. Pass ?expand=supplier_invoices to embed any open supplier invoices (registered / approved / partially_paid / overdue / disputed) for the supplier in the same response.',
  useWhen:
    'You need the full supplier record: address, payment terms, banking details, default expense account: before booking a supplier invoice or syncing to an external AP system.',
  doNotUseFor:
    'Listing suppliers (use the list endpoint). Looking up customer or employee records (different resources).',
  pitfalls: [
    'archived_at is non-null when the supplier has been soft-deleted; the supplier is still queryable by id but excluded from default lists.',
    'Banking fields (bankgiro / plusgiro / iban / bic) are stored as supplied; no Luhn or IBAN check is performed at this layer.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        name: 'Office Depot AB',
        supplier_type: 'swedish_business',
        email: 'invoices@officedepot.example',
        org_number: '556677-8899',
        bankgiro: '123-4567',
        default_expense_account: '5410',
        default_payment_terms: 30,
        default_currency: 'SEK',
        archived_at: null,
        created_at: '2026-04-12T08:30:00Z',
        updated_at: '2026-04-30T11:22:09Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(SupplierDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'suppliers.get',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier id must be a UUID.' },
      })
    }
    const supplierId = idParse.data

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

    const { data: supplier, error } = await ctx.supabase
      .from('suppliers')
      .select(SUPPLIER_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', supplierId)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!supplier) {
      ctx.log.warn('suppliers.get: not found', { supplierId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'supplier' },
      })
    }

    let supplier_invoices: unknown[] | undefined
    const partialExpansions: string[] = []
    if (expand.has('supplier_invoices')) {
      const { data: invs, error: invErr } = await ctx.supabase
        .from('supplier_invoices')
        .select(OPEN_SUPPLIER_INVOICE_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('supplier_id', supplierId)
        .in('status', OPEN_SUPPLIER_INVOICE_STATUSES)
        .order('due_date', { ascending: true })

      if (invErr) {
        // Soft-degrade: log but still return the supplier. Same Postgres
        // class-42 (auth/access) treatment as the customers expand handler.
        const errMsg = (invErr as { code?: string; message?: string }).message ?? 'unknown'
        const errCode = (invErr as { code?: string }).code ?? 'unknown'
        const isPermissionError = typeof errCode === 'string' && errCode.startsWith('42')
        if (isPermissionError) {
          ctx.log.error('suppliers.get: open-invoices expansion permission denied', new Error(errMsg), {
            errCode,
            supplierId,
          })
        } else {
          ctx.log.warn('suppliers.get: open-invoices expansion failed', { errCode, errMsg })
        }
        supplier_invoices = []
        partialExpansions.push('supplier_invoices')
      } else {
        supplier_invoices = invs ?? []
      }
    }

    return ok(
      { ...supplier, ...(supplier_invoices !== undefined ? { supplier_invoices } : {}) },
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
  operation: 'suppliers.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/suppliers/:id',
  summary: 'Partially update a supplier.',
  description:
    'Patches the supplier with the supplied fields. All fields optional. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
  useWhen:
    'You need to change a supplier\'s contact details, payment terms, banking info, default expense account, or VAT number. Use dry-run first to confirm the merged record before committing.',
  doNotUseFor:
    'Archiving a supplier (use DELETE: sets archived_at). Replacing the entire record (no PUT verb is exposed; PATCH is partial).',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'org_number uniqueness is enforced at DB level: 23505 → 409 SUPPLIER_DUPLICATE_ORG_NUMBER.',
    'Changing default_expense_account does not retroactively rebook prior supplier invoices: only future bookings pick up the new default.',
  ],
  example: {
    request: { default_payment_terms: 14, notes: 'New payment terms agreed 2026-05-12.' },
    response: {
      data: {
        id: '0e9c…',
        name: 'Office Depot AB',
        default_payment_terms: 14,
        notes: 'New payment terms agreed 2026-05-12.',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateSupplierSchema },
  response: { success: dataEnvelope(SupplierDetail) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'suppliers.update',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier id must be a UUID.' },
      })
    }
    const supplierId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = V1PatchSupplierSchema.safeParse(rawBody)
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
      'name',
      'supplier_type',
      'email',
      'phone',
      'address_line1',
      'address_line2',
      'postal_code',
      'city',
      'country',
      'org_number',
      'vat_number',
      'bankgiro',
      'plusgiro',
      'bank_account',
      'iban',
      'bic',
      'default_expense_account',
      'default_payment_terms',
      'default_currency',
      'notes',
      'archived_at',
    ] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }

    if (Object.keys(updateData).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field must be supplied for update.' },
      })
    }

    // Mirror is_active (legacy boolean) when archived_at changes. Keeps the
    // dashboard's "show only active suppliers" filters working without
    // backfill: every v1 archive/un-archive flows through here and the
    // bulk-create.
    if (Object.prototype.hasOwnProperty.call(updateData, 'archived_at')) {
      updateData.is_active = updateData.archived_at === null
    }

    // Fetch the current row up front. Needed for the BFL 7 kap immutability
    // check below: a supplier with `archived_at IS NOT NULL` is part of the
    // räkenskapsinformation backing historical verifikationer and must not
    // have its name / address / banking fields mutated. The single exception
    // is un-archiving (PATCH archived_at: null).
    const { data: current, error: currentFetchErr } = await ctx.supabase
      .from('suppliers')
      .select(SUPPLIER_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', supplierId)
      .maybeSingle()

    if (currentFetchErr) {
      return v1ErrorResponse(currentFetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!current) {
      ctx.log.warn('suppliers.update: not found', { supplierId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'supplier' },
      })
    }

    const currentArchivedAt = (current as { archived_at: string | null }).archived_at
    const isUnArchiving = updateData.archived_at === null
    if (currentArchivedAt && !isUnArchiving) {
      // BFL 7 kap 1 § protects räkenskapsinformation: the identifying
      // fields that historical verifikationer reference through their join
      // to this row. Internal notes / payment-config don't qualify, so we
      // only refuse the PATCH when an identifying field is in the update.
      // The dashboard equivalent allows the same narrow exception.
      const PROTECTED_FIELDS = new Set([
        'name',
        'supplier_type',
        'org_number',
        'vat_number',
        'address_line1',
        'address_line2',
        'postal_code',
        'city',
        'country',
        'bankgiro',
        'plusgiro',
        'bank_account',
        'iban',
        'bic',
      ])
      const offendingFields = Object.keys(updateData).filter((k) => PROTECTED_FIELDS.has(k))
      if (offendingFields.length > 0) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'archived_at',
            message:
              'Supplier is archived; identifying fields (name, address, banking, org/vat number) are räkenskapsinformation under BFL 7 kap 1 § and cannot be edited. Un-archive (PATCH archived_at: null) first if a correction is needed.',
            archived_at: currentArchivedAt,
            offending_fields: offendingFields,
          },
        })
      }
      // Non-identifying fields (notes, default_payment_terms,
      // default_expense_account, default_currency, email, phone) are not
      // räkenskapsinformation: fall through and allow the update.
    }

    if (ctx.dryRun) {
      return dryRunPreview({ ...current, ...updateData }, { requestId: ctx.requestId, log: ctx.log })
    }

    const { data, error } = await ctx.supabase
      .from('suppliers')
      .update(updateData)
      .eq('company_id', ctx.companyId!)
      .eq('id', supplierId)
      .select(SUPPLIER_DETAIL_COLUMNS)
      .maybeSingle()

    if (error) {
      if (error.code === '23505') {
        return v1ErrorResponseFromCode('SUPPLIER_DUPLICATE_ORG_NUMBER', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'org_number' },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('suppliers.update: not found', { supplierId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'supplier' },
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
  operation: 'suppliers.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/suppliers/:id',
  summary: 'Archive a supplier (soft-delete).',
  description:
    'Sets archived_at on the supplier; the record is preserved (supplier invoices and audit history remain intact) but excluded from default list responses. To un-archive, PATCH archived_at back to null. Idempotent: archiving an already-archived supplier is a no-op. Dry-runnable.',
  useWhen:
    'You want to remove a supplier from active rosters without losing their history. Idempotent: re-archiving is safe.',
  doNotUseFor:
    'Permanently deleting a supplier with all history: the public API does not expose hard-delete. GDPR erasure requests go through a dedicated workflow.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A supplier with any open supplier invoice (registered / approved / partially_paid / overdue / disputed) cannot be archived: returns 409 SUPPLIER_HAS_INVOICES. Close the invoices first. This protects BFL 7 kap audit: the supplier record is the canonical source of seller name/address for invoice reissuance.',
    '204 No Content is returned on success: there is no response body to parse.',
  ],
  example: {
    response: { data: null, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'suppliers:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'suppliers.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier id must be a UUID.' },
      })
    }
    const supplierId = idParse.data

    const { count: openInvoiceCount, error: openErr } = await ctx.supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId!)
      .eq('supplier_id', supplierId)
      .in('status', OPEN_SUPPLIER_INVOICE_STATUSES)

    if (openErr) {
      return v1ErrorResponse(openErr, ctx.log, { requestId: ctx.requestId })
    }
    if ((openInvoiceCount ?? 0) > 0) {
      return v1ErrorResponseFromCode('SUPPLIER_HAS_INVOICES', ctx.log, {
        requestId: ctx.requestId,
        details: { open_invoice_count: openInvoiceCount },
      })
    }

    if (ctx.dryRun) {
      const { data: current, error: fetchErr } = await ctx.supabase
        .from('suppliers')
        .select(SUPPLIER_DETAIL_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('id', supplierId)
        .maybeSingle()

      if (fetchErr) {
        return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!current) {
        ctx.log.warn('suppliers.delete dry-run: not found', { supplierId, companyId: ctx.companyId })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'supplier' },
        })
      }

      return dryRunPreview(
        { ...current, archived_at: new Date().toISOString() },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('suppliers')
      .update({ archived_at: new Date().toISOString(), is_active: false })
      .eq('company_id', ctx.companyId!)
      .eq('id', supplierId)
      .select('id')
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('suppliers.delete: not found', { supplierId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'supplier' },
      })
    }

    return noContent({ requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
