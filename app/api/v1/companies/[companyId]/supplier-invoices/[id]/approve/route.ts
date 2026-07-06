/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/approve
 *
 * Transitions a `registered` supplier invoice to `approved`. No journal entry
 * is involved in this transition: the registration JE has already been posted
 * (under accrual) or is deferred to :mark-paid (under cash). Idempotent
 * (mandatory Idempotency-Key). Dry-runnable.
 *
 * Strict-mode: the optimistic-lock UPDATE filters on status='registered' so
 * concurrent calls (or a same-key replay racing the first) yield a clean 409
 * rather than a silent no-op.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { eventBus } from '@/lib/events'
import type { SupplierInvoice } from '@/types'

const SI_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, is_credit_note, registration_journal_entry_id, payment_journal_entry_id, created_at, updated_at'

const SupplierInvoiceApproved = z.object({
  id: z.string().uuid(),
  status: z.literal('approved'),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
})

registerEndpoint({
  operation: 'supplier-invoices.approve',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/approve',
  summary: 'Approve a registered supplier invoice.',
  description:
    'Flips a supplier invoice from `registered` to `approved`. No journal entry is posted here: the registration JE was already booked at :create under accrual, or is deferred to :mark-paid under cash. Idempotent. Dry-runnable.',
  useWhen:
    'A registered SI has been reviewed and you want to mark it ready for payment. Many AP workflows gate :mark-paid behind an explicit approval step.',
  doNotUseFor:
    'Posting a journal entry (already done at :create under accrual). Paying the SI (use :mark-paid). Re-approving an already-approved SI (returns 400 SI_APPROVE_NOT_REGISTERED).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Returns 400 SI_APPROVE_NOT_REGISTERED when current status !== "registered". Use the detail endpoint to inspect status first if unsure.',
  ],
  example: {
    response: {
      data: { id: '0e9c…', status: 'approved', arrival_number: 42, supplier_invoice_number: '2026-1234' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(SupplierInvoiceApproved) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.approve',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('supplier_invoices')
      .select(SI_RESPONSE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('SI_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((existing as { status: string }).status !== 'registered') {
      return v1ErrorResponseFromCode('SI_APPROVE_NOT_REGISTERED', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        { ...(existing as object), status: 'approved' },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('supplier_invoices')
      .update({ status: 'approved' })
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .eq('status', 'registered')
      .select(SI_RESPONSE_COLUMNS)
      .maybeSingle()

    if (error) {
      ctx.log.error('supplier-invoice approve update failed', error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('SI_APPROVE_UPDATE_FAILED', ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      // Race: status transitioned between pre-flight and update.
      return v1ErrorResponseFromCode('SI_APPROVE_NOT_REGISTERED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.approved',
        payload: {
          supplierInvoice: data as unknown as SupplierInvoice,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.warn('supplier_invoice.approved emit failed', err as Error)
    }

    return ok(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
