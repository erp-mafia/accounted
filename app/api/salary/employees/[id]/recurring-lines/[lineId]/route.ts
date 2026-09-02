import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import {
  UpdateEmployeeRecurringLineSchema,
  RECURRING_LINE_PERIOD_ORDER_MESSAGE,
} from '@/lib/api/schemas'
import {
  validateRecurringLineAmount,
  type RecurringLineItemType,
} from '@/lib/salary/recurring-lines'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const PATCH = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.employees.recurring_lines.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, lineId } = await params

    const validation = await validateBody(request, UpdateEmployeeRecurringLineSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing, error: fetchError } = await supabase
      .from('employee_recurring_lines')
      .select('item_type, valid_from, valid_to')
      .eq('id', lineId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .single()

    // Only zero rows (PGRST116) means the line really isn't there. A
    // transport/DB failure is not a missing record and must not be reported as
    // one.
    if (fetchError && fetchError.code !== 'PGRST116') {
      return NextResponse.json({ error: getUserErrorMessage(fetchError) }, { status: 500 })
    }
    if (!existing) {
      return NextResponse.json({ error: 'Raden hittades inte' }, { status: 404 })
    }

    // Amount sign against the stored item_type: the partial schema cannot
    // check this because item_type is not patchable and never in the body.
    if (body.amount !== undefined) {
      const signError = validateRecurringLineAmount(
        existing.item_type as RecurringLineItemType,
        body.amount,
      )
      if (signError) {
        return NextResponse.json({ error: signError }, { status: 400 })
      }
    }

    // Validity period against the MERGED state: the partial schema can only
    // compare the two dates when the body carries both; when only one is
    // patched, the other half lives on the row we just fetched. Inclusive
    // bound, and a null/cleared valid_to stays legal.
    const mergedValidFrom = (body.valid_from ?? existing.valid_from ?? null) as string | null
    const mergedValidTo = (
      body.valid_to !== undefined ? body.valid_to : existing.valid_to ?? null
    ) as string | null
    if (mergedValidFrom !== null && mergedValidTo !== null && mergedValidTo < mergedValidFrom) {
      return NextResponse.json({ error: RECURRING_LINE_PERIOD_ORDER_MESSAGE }, { status: 400 })
    }

    // Explicit literal keys (not a body spread) so the phantom-column
    // scanner can verify every column this update can touch.
    const updates: Record<string, unknown> = {}
    if (body.description !== undefined) updates.description = body.description
    if (body.amount !== undefined) updates.amount = body.amount
    if (body.account_number !== undefined) updates.account_number = body.account_number
    if (body.valid_from !== undefined) updates.valid_from = body.valid_from
    if (body.valid_to !== undefined) updates.valid_to = body.valid_to
    if (body.metadata !== undefined) updates.metadata = body.metadata
    if (body.is_active !== undefined) updates.is_active = body.is_active

    const { data, error } = await supabase
      .from('employee_recurring_lines')
      .update(updates)
      .eq('id', lineId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      // The row's existence was already established above, so `error` here is
      // a write failure, not a lookup miss. PGRST116 (zero rows) is the only
      // shape that still means not-found: the row was deleted or moved out of
      // the company between fetch and update.
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Raden hittades inte' }, { status: 404 })
      }
      // Both the amount sign and the merged period were validated above, so a
      // check_violation on UPDATE is a concurrent write that moved the other
      // half of a constraint after our check. The period is the plausible one;
      // answer 400 with the same copy the schema uses.
      if (error.code === '23514') {
        return NextResponse.json({ error: RECURRING_LINE_PERIOD_ORDER_MESSAGE }, { status: 400 })
      }
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ error: 'Raden hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.employees.recurring_lines.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, lineId } = await params

    // Delete-first, no pre-check: the FK from salary_line_items is NO
    // ACTION, so the database itself refuses (23503) whenever any derived
    // row references the line, including one inserted by a calculation
    // racing this request. A referenced line is deactivated instead: the
    // provenance link stays intact, the next recalculation drops draft
    // derived rows and never re-derives.
    // Selecting the deleted row separates "deleted" from "matched nothing":
    // a filtered DELETE reports no error when the id is unknown or belongs to
    // another company, which would otherwise answer 200 deleted: true.
    const { data: deleted, error } = await supabase
      .from('employee_recurring_lines')
      .delete()
      .eq('id', lineId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .select('id')
      .maybeSingle()

    if (error && error.code !== '23503') {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    if (error) {
      const { error: deactivateError } = await supabase
        .from('employee_recurring_lines')
        .update({ is_active: false })
        .eq('id', lineId)
        .eq('employee_id', id)
        .eq('company_id', companyId)

      if (deactivateError) {
        return NextResponse.json({ error: getUserErrorMessage(deactivateError) }, { status: 500 })
      }

      return NextResponse.json({ data: { id: lineId, deleted: false, deactivated: true } })
    }

    if (!deleted) {
      return NextResponse.json({ error: 'Raden hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data: { id: lineId, deleted: true } })
  },
  { requireWrite: true },
)
