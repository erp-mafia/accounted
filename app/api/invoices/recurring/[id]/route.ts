import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { UpdateRecurringScheduleSchema } from '@/lib/api/schemas'
import {
  computeInitialRunDate,
  computeNextRunDate,
  getStockholmDateHour,
} from '@/lib/invoices/recurring-schedule-service'

ensureInitialized()

export const GET = withRouteContext(
  'recurring_invoice.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log } = ctx
    const { data, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(*), items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !data) {
      log.warn('recurring schedule not found', { scheduleId: id })
      return NextResponse.json(
        { error: 'Schedule not found', type: 'not_found' },
        { status: 404 },
      )
    }
    return NextResponse.json({ data })
  },
)

export const PATCH = withRouteContext(
  'recurring_invoice.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = UpdateRecurringScheduleSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
            code: i.code,
          })),
        },
        { status: 400 },
      )
    }
    const input = parsed.data
    const { items, ...scheduleFields } = input

    // Only forward fields the user actually supplied.
    const updateRow: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(scheduleFields)) {
      if (v !== undefined) updateRow[k] = v
    }

    // Turning auto_send on (or moving the schedule to another customer while
    // it is on) requires the customer to have an email address; otherwise
    // every cron run degrades to a draft + warning. Mirrors the create
    // route's guard.
    if (input.auto_send === true || input.customer_id !== undefined) {
      const { data: current } = await supabase
        .from('recurring_invoice_schedules')
        .select('auto_send, customer_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (!current) {
        return NextResponse.json(
          { error: 'Schedule not found', type: 'not_found' },
          { status: 404 },
        )
      }

      const effectiveAutoSend = input.auto_send ?? current.auto_send
      if (effectiveAutoSend) {
        const { data: customer } = await supabase
          .from('customers')
          .select('email')
          .eq('id', input.customer_id ?? current.customer_id)
          .eq('company_id', companyId)
          .maybeSingle()

        if (!customer?.email) {
          return NextResponse.json(
            {
              error: 'Customer has no email address: automatic sending requires one',
              type: 'validation_error',
            },
            { status: 400 },
          )
        }
      }
    }

    // Recompute next_run_date when either the schedule is being reactivated
    // (from a stale date) or its day-of-month actually changed via an edit.
    if (input.status === 'active' || input.day_of_month !== undefined) {
      const { data: existing } = await supabase
        .from('recurring_invoice_schedules')
        .select('next_run_date, day_of_month')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (!existing) {
        return NextResponse.json(
          { error: 'Schedule not found', type: 'not_found' },
          { status: 404 },
        )
      }

      const reactivating = input.status === 'active'
      const dayChanged =
        input.day_of_month !== undefined && input.day_of_month !== existing.day_of_month
      const effectiveDay = input.day_of_month ?? existing.day_of_month
      const { date: todayStockholm } = getStockholmDateHour(new Date())
      const stockholmToday = new Date(`${todayStockholm}T00:00:00Z`)

      // Recompute to the next STRICTLY-future occurrence (never today, so an
      // edit or reactivation can't trigger a same-hour surprise send; today's
      // invoice is the explicit run-now action instead) when either:
      //   - reactivating a schedule whose date already passed (e.g. the safety
      //     pause when the send-hour cron shipped), or
      //   - the day-of-month changed, so "Nästa körning" follows the new day.
      // Editing other fields (name, items, time) leaves next_run_date alone,
      // so an unrelated edit never skips an imminent send.
      const staleOnReactivate = reactivating && existing.next_run_date <= todayStockholm
      if (staleOnReactivate || dayChanged) {
        const rolled = computeInitialRunDate(stockholmToday, effectiveDay)
        updateRow.next_run_date =
          rolled === todayStockholm
            ? computeNextRunDate(stockholmToday, effectiveDay)
            : rolled
      }

      // A conscious reactivation invalidates any lingering warning (the
      // safety-pause note, or a stale failure from months ago).
      if (reactivating) {
        updateRow.last_run_warning = null
      }
    }

    if (Object.keys(updateRow).length > 0) {
      const { error: updateError } = await supabase
        .from('recurring_invoice_schedules')
        .update(updateRow)
        .eq('id', id)
        .eq('company_id', companyId)

      if (updateError) {
        log.error('failed to update recurring schedule', updateError)
        return errorResponse(updateError, log, { requestId })
      }
    }

    if (items) {
      // Replace items wholesale. Cheaper than diffing for a small list and
      // matches how the UI form sends the full list back on every save.
      const { data: existing } = await supabase
        .from('recurring_invoice_schedules')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (!existing) {
        return NextResponse.json(
          { error: 'Schedule not found', type: 'not_found' },
          { status: 404 },
        )
      }

      // Snapshot existing rows so we can restore them if the insert fails.
      // Without this, a failed replace would leave the schedule with zero
      // items and every subsequent cron run would throw "schedule has no
      // items", silently skipping billing dates.
      const { data: previousItems } = await supabase
        .from('recurring_invoice_schedule_items')
        .select('sort_order, description, quantity, unit, unit_price, vat_rate')
        .eq('schedule_id', id)

      await supabase
        .from('recurring_invoice_schedule_items')
        .delete()
        .eq('schedule_id', id)

      const itemRows = items.map((item, idx) => ({
        schedule_id: id,
        sort_order: idx,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        vat_rate: item.vat_rate ?? null,
      }))
      const { error: itemsError } = await supabase
        .from('recurring_invoice_schedule_items')
        .insert(itemRows)
      if (itemsError) {
        log.error('failed to replace schedule items', itemsError)
        // Restore the snapshot so the schedule stays valid for the cron.
        if (previousItems && previousItems.length > 0) {
          const restoreRows = previousItems.map((row) => ({
            schedule_id: id,
            sort_order: row.sort_order,
            description: row.description,
            quantity: row.quantity,
            unit: row.unit,
            unit_price: row.unit_price,
            vat_rate: row.vat_rate,
          }))
          const { error: restoreError } = await supabase
            .from('recurring_invoice_schedule_items')
            .insert(restoreRows)
          if (restoreError) {
            log.error(
              'failed to restore schedule items after failed replace: schedule may be left empty',
              restoreError,
              { scheduleId: id },
            )
          }
        }
        return errorResponse(itemsError, log, { requestId })
      }
    }

    const { data: complete } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(*), items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    return NextResponse.json({ data: complete })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'recurring_invoice.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    // Items cascade-delete via FK ON DELETE CASCADE.
    const { error } = await supabase
      .from('recurring_invoice_schedules')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      log.error('failed to delete recurring schedule', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
