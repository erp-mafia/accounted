/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/approve
 *
 * Attests a `registered` or `overdue` supplier invoice. No journal entry is
 * involved in this transition: the registration JE has already been posted
 * (under accrual) or is deferred to :mark-paid (under cash). Idempotent
 * (mandatory Idempotency-Key). Dry-runnable.
 *
 * The resulting status is `approved`, or `overdue` when the invoice is still
 * past its due date: 'overdue' is derived state the daily cron owns, and
 * attesting a late payable does not make it on time (#1206).
 *
 * Strict-mode: the optimistic-lock UPDATE filters on the pre-approval state
 * (status in registered/overdue, approved_at IS NULL) so concurrent calls (or
 * a same-key replay racing the first) yield a clean 409 rather than a silent
 * no-op.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { eventBus } from '@/lib/events'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import {
  canApproveSupplierInvoice,
  resolveUnsettledStatus,
} from '@/lib/supplier-invoices/lifecycle'
import type { SupplierInvoice } from '@/types'

const SI_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, approved_at, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, is_credit_note, registration_journal_entry_id, payment_journal_entry_id, created_at, updated_at'

const SupplierInvoiceApproved = z.object({
  id: z.string().uuid(),
  // 'overdue' when the attested invoice is still past its due date.
  status: z.enum(['approved', 'overdue']),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
})

registerEndpoint({
  operation: 'supplier-invoices.approve',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/approve',
  summary: 'Approve a registered or overdue supplier invoice.',
  description:
    'Attests a supplier invoice that has not been approved yet (status `registered` or `overdue`). The resulting status is `approved`, or `overdue` when the invoice is still past its due date. No journal entry is posted here: the registration JE was already booked at :create under accrual, or is deferred to :mark-paid under cash. Idempotent. Dry-runnable.',
  useWhen:
    'A registered SI has been reviewed and you want to mark it ready for payment. Many AP workflows gate :mark-paid behind an explicit approval step.',
  doNotUseFor:
    'Posting a journal entry (already done at :create under accrual). Paying the SI (use :mark-paid). Re-approving an already-approved SI (returns 400 SI_APPROVE_NOT_REGISTERED).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Returns 400 SI_APPROVE_NOT_REGISTERED when the invoice is already approved (approved_at set) or sits in a settled status. Use the detail endpoint to inspect status first if unsure.',
    'A still-past-due invoice comes back with status "overdue", not "approved": approved_at is the attest marker, the status is derived from the due date.',
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
    // 'overdue' is approvable: the daily cron flips unbooked invoices there
    // just by aging (#1206). approved_at is what makes approval idempotent.
    const invoice = existing as {
      status: string
      approved_at?: string | null
      due_date: string
      remaining_amount: number
      is_credit_note?: boolean | null
    }
    if (!canApproveSupplierInvoice(invoice)) {
      return v1ErrorResponseFromCode('SI_APPROVE_NOT_REGISTERED', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: invoice.status },
      })
    }

    // An attested invoice that is still past due keeps the 'overdue' label:
    // approving is not a reason to hide that the money is late.
    const approvedAt = new Date().toISOString()
    const nextStatus = resolveUnsettledStatus(
      { ...invoice, approved_at: approvedAt },
      getSwedishLocalDate(),
    )

    if (ctx.dryRun) {
      return dryRunPreview(
        { ...(existing as object), status: nextStatus },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('supplier_invoices')
      .update({ status: nextStatus, approved_at: approvedAt })
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .in('status', ['registered', 'overdue'])
      .is('approved_at', null)
      // nextStatus was derived from the due date read above, so pin that too:
      // a concurrent due-date edit must not be papered over with a label
      // computed from the pre-edit date.
      .eq('due_date', invoice.due_date)
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
