import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { executeRecurringSchedule } from '@/lib/invoices/recurring-schedule-service'
import type { RecurringInvoiceSchedule, RecurringInvoiceScheduleItem } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/recurring/[id]/run: manually generate (and, when the
 * schedule has auto_send, email) an invoice from a recurring schedule right
 * now, on demand.
 *
 * Why this exists: the cron never sends for a past date, and all schedules
 * were paused on the send-time rollout, so a user who wants this month's
 * invoice sent now needs an explicit, conscious action. This is that action.
 * It runs regardless of status (active or paused): the user is clicking the
 * button themselves, so awareness is not in question.
 *
 * It deliberately does NOT touch next_run_date: a manual send is out-of-band
 * and must not disturb the monthly cadence.
 */
export const POST = withRouteContext(
  'recurring_invoice.run_now',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const { data: schedule, error } = await supabase
      .from('recurring_invoice_schedules')
      .select('*, items:recurring_invoice_schedule_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !schedule) {
      log.warn('recurring schedule not found for run-now', { scheduleId: id })
      return NextResponse.json(
        { error: 'Schedule not found', type: 'not_found' },
        { status: 404 },
      )
    }

    const typed = schedule as RecurringInvoiceSchedule & {
      items: RecurringInvoiceScheduleItem[]
    }

    try {
      const result = await executeRecurringSchedule(supabase, typed, new Date())

      // Record the run for the list view (generated count, last invoice,
      // warning) but leave next_run_date untouched: the monthly cadence runs
      // independently of this manual send.
      const { error: updateError } = await supabase
        .from('recurring_invoice_schedules')
        .update({
          last_run_at: new Date().toISOString(),
          last_invoice_id: result.invoiceId,
          last_run_warning: result.warning,
          generated_count: typed.generated_count + 1,
        })
        .eq('id', id)
        .eq('company_id', companyId)

      if (updateError) {
        // The invoice exists; the tracking update failing is non-fatal. Log
        // loudly and still return the created invoice.
        log.error(
          'invoice created but failed to update schedule after run-now',
          updateError,
          { scheduleId: id, invoiceId: result.invoiceId },
        )
      }

      return NextResponse.json({
        data: {
          invoiceId: result.invoiceId,
          invoiceNumber: result.invoiceNumber,
          autoSent: result.autoSent,
          warning: result.warning,
        },
      })
    } catch (err) {
      log.error('run-now failed to generate invoice', err as Error, { scheduleId: id })
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
