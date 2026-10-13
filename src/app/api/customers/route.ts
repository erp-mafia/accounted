import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import type { Customer } from '@/types'
import { maskCustomerRow } from '@/lib/customers/protect-personal-number'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createCustomer } from '@/lib/customers/customer-commands'
import { customerFailureResponse } from '@/lib/customers/customer-failure-response'

export const GET = withRouteContext(
  'customer.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    // Paginated: PostgREST caps an unranged select at 1000 rows, which would
    // hand the roster page a silently truncated customer list. Ordered on the
    // PK because paging is only stable under a unique total order; the
    // name sort callers expect is re-applied below.
    //
    // Archived rows (soft-deleted via the v1 API) stay in the table for BFL
    // retention but are not part of the roster: same canonical
    // `archived_at IS NULL` filter as the v1 list route.
    let rows: Customer[]
    try {
      rows = await fetchAllRows<Customer>(
        ({ from, to }) =>
          supabase
            .from('customers')
            .select('*')
            .eq('company_id', companyId)
            .is('archived_at', null)
            .order('id', { ascending: true })
            .range(from, to),
        { dedupeBy: (row) => row.id },
      )
    } catch (error) {
      log.error('customer list failed', error as Error)
      return errorResponse(error, log, { requestId })
    }

    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'sv'))

    return NextResponse.json({ data: rows.map(maskCustomerRow) })
  },
)

export const POST = withRouteContext(
  'customer.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, CreateCustomerSchema, {
      log,
      operation: 'customer.create',
    })
    if (!result.success) return result.response

    // One insert and one rule set with v1 and the agent's approval
    // (lib/customers/customer-commands.ts).
    const outcome = await createCustomer({ supabase, companyId: companyId!, userId: user.id, log }, result.data)
    if (!outcome.ok) return customerFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('customer.create: unexpected dry-run outcome')

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
