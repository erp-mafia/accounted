import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { CreateRecurringScheduleSchema } from '@/lib/api/schemas'
import { computeInitialRunDate } from '@/lib/invoices/recurring-schedule-service'

ensureInitialized()

export const GET = withRouteContext(
  'recurring_invoice.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const { data, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(id,name,email), items:recurring_invoice_schedule_items(*)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (error) {
      log.error('failed to list recurring schedules', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'recurring_invoice.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = CreateRecurringScheduleSchema.safeParse(rawBody)
    if (!parsed.success) {
      log.warn('recurring schedule validation failed', {
        issueCount: parsed.error.issues.length,
      })
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

    // Verify the customer belongs to this company (defense in depth + clearer
    // 404 than the FK violation we'd otherwise get).
    const { data: customer } = await supabase
      .from('customers')
      .select('id, email')
      .eq('id', input.customer_id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!customer) {
      return NextResponse.json(
        { error: 'Customer not found', type: 'not_found' },
        { status: 404 },
      )
    }

    // auto_send without a customer email would silently degrade to a monthly
    // draft + warning at cron time. Reject it up front instead; the dialog
    // blocks this client-side, so this is the API backstop.
    if (input.auto_send && !customer.email) {
      return NextResponse.json(
        {
          error: 'Customer has no email address: automatic sending requires one',
          type: 'validation_error',
        },
        { status: 400 },
      )
    }

    const nextRunDate = computeInitialRunDate(
      new Date(),
      input.day_of_month,
      input.start_date,
    )

    const { data: schedule, error: insertError } = await supabase
      .from('recurring_invoice_schedules')
      .insert({
        company_id: companyId,
        user_id: user.id,
        customer_id: input.customer_id,
        name: input.name,
        day_of_month: input.day_of_month,
        send_hour: input.send_hour,
        payment_terms_days: input.payment_terms_days,
        currency: input.currency,
        your_reference: input.your_reference ?? null,
        our_reference: input.our_reference ?? null,
        notes: input.notes ?? null,
        auto_send: input.auto_send,
        next_run_date: nextRunDate,
        status: 'active',
      })
      .select()
      .single()

    if (insertError || !schedule) {
      log.error('failed to insert recurring schedule', insertError)
      return errorResponse(insertError ?? new Error('insert failed'), log, { requestId })
    }

    const itemRows = input.items.map((item, idx) => ({
      schedule_id: schedule.id,
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
      // Roll back the parent so a half-created schedule doesn't ship.
      await supabase
        .from('recurring_invoice_schedules')
        .delete()
        .eq('id', schedule.id)
        .eq('company_id', companyId)
      log.error('failed to insert schedule items; rolled back schedule', itemsError)
      return errorResponse(itemsError, log, { requestId })
    }

    const { data: complete } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, customer:customers(id,name,email), items:recurring_invoice_schedule_items(*)')
      .eq('id', schedule.id)
      .single()

    return NextResponse.json({ data: complete }, { status: 201 })
  },
  { requireWrite: true },
)
