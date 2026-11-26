import { NextResponse } from 'next/server'
import { isMatchableSupplierInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { validateBody } from '@/lib/api/validate'
import { UpdateSupplierSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { updateSupplier } from '@/lib/suppliers/update-supplier'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'supplier.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const { data: supplier, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !supplier) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', opLog, { requestId })
    }

    // Paged: past 1,000 invoices the count and the totals came up short.
    const invoices = await fetchAllRows<{
      status: string
      total: number
      remaining_amount: number | null
      paid_amount: number | null
      currency: string | null
    }>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('status, total, remaining_amount, paid_amount, currency')
        .eq('supplier_id', id)
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    )

    // Amounts are in each invoice's own currency, so a single sum across a
    // mixed-currency supplier would be meaningless: group per currency instead
    // (nearly every supplier has exactly one).
    const perCurrency = new Map<string, { total_outstanding: number; total_paid: number }>()
    for (const inv of invoices) {
      const currency = inv.currency || 'SEK'
      const row = perCurrency.get(currency) ?? { total_outstanding: 0, total_paid: 0 }
      // What the supplier ledger reads as open: a reversed or disputed
      // invoice has a remainder nobody is asked to pay.
      if (isMatchableSupplierInvoiceStatus(inv.status)) {
        row.total_outstanding += inv.remaining_amount || 0
      }
      row.total_paid += inv.paid_amount || 0
      perCurrency.set(currency, row)
    }

    const stats = {
      invoice_count: invoices.length,
      by_currency: [...perCurrency.entries()]
        .map(([currency, row]) => ({
          currency,
          total_outstanding: roundOre(row.total_outstanding),
          total_paid: roundOre(row.total_paid),
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    }

    return NextResponse.json({ data: { ...supplier, stats } })
  },
  { uuidParams: { id: 'SUPPLIER_NOT_FOUND' } },
)

// The same service as the v1 PATCH and gnubok_update_supplier
// (lib/suppliers/update-supplier.ts), so the three doors take the same
// fields and keep the same rules.
export const PUT = withRouteContext(
  'supplier.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const result = await validateBody(request, UpdateSupplierSchema, {
      log: opLog,
      operation: 'supplier.update',
    })
    if (!result.success) return result.response

    const outcome = await updateSupplier({ supabase, companyId, userId: user.id, log: opLog }, id, result.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true, uuidParams: { id: 'SUPPLIER_NOT_FOUND' } },
)

export const DELETE = withRouteContext(
  'supplier.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierId: id })

    const { count } = await supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('supplier_id', id)
      .eq('company_id', companyId)

    if (count && count > 0) {
      return errorResponseFromCode('SUPPLIER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: 'has_invoices', invoiceCount: count },
      })
    }

    const { error, count: deleteCount } = await supabase
      .from('suppliers')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      opLog.error('supplier delete failed', error)
      return errorResponseFromCode('SUPPLIER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (deleteCount === 0) {
      return errorResponseFromCode('SUPPLIER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true, uuidParams: { id: 'SUPPLIER_NOT_FOUND' } },
)
