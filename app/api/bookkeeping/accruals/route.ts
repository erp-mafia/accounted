import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { firstOfMonth } from '@/lib/bookkeeping/accruals/compute'
import type { AccrualSchedule, AccrualScheduleInstallment } from '@/types'

ensureInitialized()

const ListQuerySchema = z.object({
  status: z.enum(['active', 'completed', 'cancelled', 'all']).default('active'),
})

/**
 * GET /api/bookkeeping/accruals?status=active|completed|cancelled|all
 *
 * Schedules with their installments for the periodiseringar page, plus a
 * `due_count` of pending installments whose month has begun (drives the
 * "Bokför förfallna" banner).
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
    const { status } = validated.data

    let query = supabase
      .from('accrual_schedules')
      .select('*, installments:accrual_schedule_installments(*)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    const { data, error } = await query
    if (error) {
      log.error('failed to list accrual schedules', error)
      return errorResponse(error, log, { requestId })
    }

    const todayMonth = firstOfMonth(new Date().toISOString().slice(0, 10))
    let dueCount = 0
    const schedules = ((data ?? []) as Array<
      AccrualSchedule & { installments: AccrualScheduleInstallment[] }
    >).map((schedule) => {
      const installments = [...(schedule.installments ?? [])].sort((a, b) =>
        a.period_month.localeCompare(b.period_month),
      )
      if (schedule.status === 'active') {
        dueCount += installments.filter(
          (i) => i.status === 'pending' && i.period_month <= todayMonth,
        ).length
      }
      return { ...schedule, installments }
    })

    return NextResponse.json({ data: schedules, due_count: dueCount })
  },
)
