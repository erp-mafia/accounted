/**
 * /api/v1/companies/{companyId}/suppliers/{id}: supplier detail + writes.
 *
 * GET   : full record. ?expand=supplier_invoices embeds open supplier invoices.
 * PATCH : partial update (operation suppliers.update, also served as the MCP
 *          gnubok_update_supplier; rules in lib/suppliers/update-supplier.ts).
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
import { parseExpand, expandQueryShape } from '@/lib/api/v1/expand'
import { PartyForApiSchema, expandParty } from '@/lib/parties/party-api'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { v1OperationHandler } from '@/lib/operations/v1'
import { suppliersUpdate } from '@/lib/operations/suppliers'
import { SupplierRecordSchema, readSupplierRecord } from '@/lib/suppliers/supplier-record'

// The record read here (and its select) is defined in
// lib/suppliers/supplier-record.ts, shared with the MCP drill-in
// gnubok_get_supplier; only the expansions are v1's own. PATCH is the
// suppliers.update operation (lib/suppliers/update-supplier.ts).
const SupplierDetail = SupplierRecordSchema.extend({
  /** Present with ?expand=party: identity, the SCB register summary and what the ledger has seen. */
  party: PartyForApiSchema.nullable().optional(),
})

const ALLOWED_EXPAND = ['supplier_invoices', 'party'] as const
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

const OPEN_SUPPLIER_INVOICE_COLUMNS =
  'id, supplier_invoice_number, arrival_number, invoice_date, due_date, status, currency, total, remaining_amount'

registerEndpoint({
  operation: 'suppliers.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/suppliers/:id',
  summary: 'Retrieve a single supplier by id.',
  description:
    'Returns the full supplier record. Pass ?expand=supplier_invoices to embed any open supplier invoices (registered / approved / partially_paid / overdue / disputed) for the supplier in the same response. Pass ?expand=party to embed the party (motpart) behind the supplier: legal name, org and VAT number, country, the SCB company-register summary (status, legal form, industry, seat, size, registrations, contact details, fetched date) and what the ledger has seen for it.',
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
  request: { query: z.object(expandQueryShape(ALLOWED_EXPAND)) },
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

    const { data: supplier, error } = await readSupplierRecord(ctx.supabase, ctx.companyId!, supplierId)

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

    const party = expand.has('party') ? await expandParty(ctx.supabase, ctx.companyId!, supplier.party_id) : undefined

    return ok(
      { ...supplier, ...(supplier_invoices !== undefined ? { supplier_invoices } : {}), ...(party !== undefined ? { party } : {}) },
      {
        requestId: ctx.requestId,
        partialExpansions: partialExpansions.length > 0 ? partialExpansions : undefined,
      },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: partial update (operation suppliers.update)
// ──────────────────────────────────────────────────────────────────

export const PATCH = v1OperationHandler(suppliersUpdate)

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
      const { data: current, error: fetchErr } = await readSupplierRecord(ctx.supabase, ctx.companyId!, supplierId)

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
