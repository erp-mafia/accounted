import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { installmentDueDate } from '@/lib/bookkeeping/accruals/service'
import type { AccrualSchedule, AccrualScheduleInstallment } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

const ListQuerySchema = z.object({
  status: z.enum(['active', 'completed', 'cancelled', 'all']).default('active'),
  // The schedules of one invoice, for its page's "Ändra periodisering".
  supplier_invoice_id: z.string().uuid().optional(),
  invoice_id: z.string().uuid().optional(),
})

/**
 * GET /api/bookkeeping/accruals?status=active|completed|cancelled|all
 *   [&supplier_invoice_id=…|&invoice_id=…]
 *
 * Schedules with their installments for the periodiseringar page and the
 * invoice pages, plus a `due_count` of pending installments whose day has
 * come (drives the "Bokför förfallna" banner), by the same rule the posting
 * run books by (installmentDueDate).
 */
export const GET = withRouteContext(
  'accruals.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const validated = validateQuery(request, ListQuerySchema, {
      log,
      operation: 'accruals.list',
    })
    if (!validated.success) return validated.response
    const { status, supplier_invoice_id, invoice_id } = validated.data

    let query = supabase
      .from('accrual_schedules')
      .select('*, installments:accrual_schedule_installments(*)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (status !== 'all') {
      query = query.eq('status', status)
    }
    if (supplier_invoice_id) query = query.eq('supplier_invoice_id', supplier_invoice_id)
    if (invoice_id) query = query.eq('invoice_id', invoice_id)

    const { data, error } = await query
    if (error) {
      log.error('failed to list accrual schedules', error)
      return errorResponse(error, log, { requestId })
    }

    const today = todayIsoStockholm()
    let dueCount = 0
    const schedules = ((data ?? []) as Array<
      AccrualSchedule & { installments: AccrualScheduleInstallment[] }
    >).map((schedule) => {
      const installments = [...(schedule.installments ?? [])].sort((a, b) =>
        a.period_month.localeCompare(b.period_month),
      )
      if (schedule.status === 'active') {
        dueCount += installments.filter(
          (i) => i.status === 'pending' && installmentDueDate(schedule, i.period_month) <= today,
        ).length
      }
      return { ...schedule, installments }
    })

    return NextResponse.json({ data: schedules, due_count: dueCount })
  },
)
