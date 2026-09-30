import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import {
  CreateSupplierPaymentBatchSchema,
  SupplierPaymentBatchListQuerySchema,
} from '@/lib/api/schemas'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createPaymentBatch, loadBatchProgress } from '@/lib/payments/batch-operations'
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

    const outcome = await createPaymentBatch(
      { supabase, companyId, userId: user.id, log },
      validation.data,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: create ran without a dry run')

    const batch = outcome.data
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

    const { settledCounts, invoiceIdsByBatch } = await loadBatchProgress(supabase, companyId, batchIds)

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
