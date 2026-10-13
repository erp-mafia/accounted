import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateCustomerSchema } from '@/lib/api/schemas'
import { checkCustomerDeletable } from '@/lib/customers/delete-guard'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { maskCustomerRow } from '@/lib/customers/protect-personal-number'
import { updateCustomer } from '@/lib/customers/customer-commands'
import { customerFailureResponse } from '@/lib/customers/customer-failure-response'

export const GET = withRouteContext(
  'customer.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('customer fetch failed', error)
      return errorResponseFromCode('INTERNAL_ERROR', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    // Paged: past 1,000 invoices the customer page lost its oldest ones.
    const invoices = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, due_date, status, total, currency')
        .eq('customer_id', id)
        .eq('company_id', companyId)
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
    )

    return NextResponse.json({ data: { ...maskCustomerRow(data), invoices } })
  },
)

export const PATCH = withRouteContext(
  'customer.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    const result = await validateBody(request, UpdateCustomerSchema, {
      log: opLog,
      operation: 'customer.update',
    })
    if (!result.success) return result.response

    // One update and one rule set with v1 and the agent's approval
    // (lib/customers/customer-commands.ts).
    const outcome = await updateCustomer(
      { supabase, companyId: companyId!, userId: user.id, log: opLog },
      id,
      result.data,
    )
    if (!outcome.ok) return customerFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('customer.update: unexpected dry-run outcome')

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'customer.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ customerId: id })

    // invoices, sales_orders, projects and deadlines reference customers
    // ON DELETE SET NULL, so the delete itself never refuses: it would leave
    // invoices without their buyer (crm#263). Refuse while anything that
    // needs the customer still points at it.
    const check = await checkCustomerDeletable(supabase, companyId, id)
    if (!check.deletable) {
      return errorResponseFromCode(check.code, opLog, {
        requestId,
        details: { dependents: check.dependents },
      })
    }

    const { error, count } = await supabase
      .from('customers')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      if (error.code === '23503') {
        return errorResponseFromCode('CUSTOMER_HAS_INVOICES', opLog, { requestId })
      }
      opLog.error('customer delete failed', error)
      return errorResponseFromCode('CUSTOMER_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (count === 0) {
      return errorResponseFromCode('CUSTOMER_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
