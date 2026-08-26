import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  CreateSupplierPaymentBatchSchema,
  SupplierPaymentBatchListQuerySchema,
} from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createSupplierPaymentBatch } from '@/lib/payments/batch-service'
import type { SupplierPaymentBatch } from '@/types'

/**
 * Create a supplier payment batch (betalfil).
 *
 * Creating a batch snapshots payee + reference + amount per invoice and mints
 * the pain.001 MsgId; it books NOTHING and settles nothing. The client
 * downloads the file from GET /payment-batches/{id}/file afterwards, and
 * settlement stays in mark-paid / bank matching once the bank has executed.
 */
export const POST = withRouteContext(
  'supplier_invoice.payment_batch.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateSupplierPaymentBatchSchema, {
      log,
      operation: 'supplier_invoice.payment_batch.create',
    })
    if (!validation.success) return validation.response

    const result = await createSupplierPaymentBatch(supabase, companyId, user.id, validation.data)

    if (!result.ok) {
      switch (result.code) {
        case 'debtor_incomplete':
          return errorResponseFromCode('SI_BATCH_DEBTOR_INCOMPLETE', log, {
            requestId,
            details: { missing: result.missing },
          })
        case 'ineligible':
          return errorResponseFromCode('SI_BATCH_INELIGIBLE_INVOICE', log, {
            requestId,
            details: { invoices: result.details },
          })
        case 'invalid_amount':
          return errorResponseFromCode('SI_BATCH_INVALID_AMOUNT', log, {
            requestId,
            details: { invoices: result.details },
          })
        case 'amount_exceeds_remaining':
          return errorResponseFromCode('SI_BATCH_AMOUNT_EXCEEDS_REMAINING', log, {
            requestId,
            details: { invoices: result.details },
          })
        case 'already_batched':
          return errorResponseFromCode('SI_BATCH_DUPLICATE_INVOICE', log, {
            requestId,
            details: { invoices: result.details },
          })
        default:
          return errorResponseFromCode('SI_BATCH_CREATE_FAILED', log, { requestId })
      }
    }

    const { batch } = result
    return NextResponse.json(
      {
        data: {
          id: batch.id,
          msg_id: batch.msg_id,
          format: batch.format,
          total_amount: batch.total_amount,
          item_count: batch.item_count,
          created_at: batch.created_at,
        },
      },
      { status: 201 },
    )
  },
  { requireWrite: true },
)

/**
 * List payment batches. Settlement progress is derived from the live invoice
 * rows (never stored): settled = remaining_amount at or under the öre epsilon.
 * For active (created) batches the member invoice ids ride along so the list
 * page can build its "I betalfil" chip map from one fetch.
 */
export const GET = withRouteContext(
  'supplier_invoice.payment_batch.list',
  async (request, { supabase, companyId }) => {
    const validation = validateQuery(request, SupplierPaymentBatchListQuerySchema)
    if (!validation.success) return validation.response
    const { status, limit, offset } = validation.data

    let query = supabase
      .from('supplier_payment_batches')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (status !== 'all') query = query.eq('status', status)

    const { data: batches, error } = await query
    if (error) throw error

    const batchRows = (batches ?? []) as SupplierPaymentBatch[]
    const batchIds = batchRows.map((batch) => batch.id)

    const settledCounts = new Map<string, number>()
    const invoiceIdsByBatch = new Map<string, string[]>()
    if (batchIds.length > 0) {
      const { data: items } = await supabase
        .from('supplier_payment_batch_items')
        .select('batch_id, supplier_invoice_id, invoice:supplier_invoices(remaining_amount)')
        .eq('company_id', companyId)
        .in('batch_id', batchIds)

      for (const item of items ?? []) {
        const invoice = item.invoice as unknown as { remaining_amount: number } | null
        if (invoice && invoice.remaining_amount <= 0.005) {
          settledCounts.set(item.batch_id, (settledCounts.get(item.batch_id) ?? 0) + 1)
        }
        const list = invoiceIdsByBatch.get(item.batch_id)
        if (list) list.push(item.supplier_invoice_id)
        else invoiceIdsByBatch.set(item.batch_id, [item.supplier_invoice_id])
      }
    }

    return NextResponse.json({
      data: batchRows.map((batch) => ({
        ...batch,
        settled_count: settledCounts.get(batch.id) ?? 0,
        ...(batch.status === 'created'
          ? { supplier_invoice_ids: invoiceIdsByBatch.get(batch.id) ?? [] }
          : {}),
      })),
    })
  },
)
