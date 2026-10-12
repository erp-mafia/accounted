import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateSupplierSchema } from '@/lib/api/schemas'
import { createSupplier } from '@/lib/suppliers/create-supplier'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Supplier } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export const GET = withRouteContext(
  'supplier.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    // Archived rows (soft-deleted via the v1 API: archived_at + is_active=false)
    // stay in the table for BFL retention but are not part of the roster.
    // Same canonical "active" filter as the v1 list route. Paged: the roster
    // used to end at 1,000 suppliers.
    let data: Supplier[]
    try {
      data = await fetchAllRows<Supplier>(({ from, to }) =>
        supabase
          .from('suppliers')
          .select('*')
          .eq('company_id', companyId)
          .is('archived_at', null)
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      )
    } catch (error) {
      log.error('supplier list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'supplier.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, CreateSupplierSchema, {
      log,
      operation: 'supplier.create',
    })
    if (!result.success) return result.response

    // One insert and one rule set with v1 and the agent's approval
    // (lib/suppliers/create-supplier.ts).
    const outcome = await createSupplier({ supabase, companyId, userId: user.id, log }, result.data)
    if (!outcome.ok) {
      if (outcome.code === 'SUPPLIER_CREATE_FAILED') {
        return errorResponseFromCode('SUPPLIER_CREATE_FAILED', log, {
          requestId,
          details: { reason: getUserErrorMessage(outcome.error) },
        })
      }
      return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
    }
    if (outcome.dryRun) throw new Error('supplier.create: unexpected dry-run outcome')

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
