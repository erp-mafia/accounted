import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import {
  CREATE_NEEDS_A_PERIOD,
  CreateManualAccrualFields,
  accrualSchedulesCreate,
  createNamesPeriod,
} from '@/lib/operations/accrual-schedules'
import { sessionFailureResponse } from '@/lib/operations/session'
import { installmentDueDate } from '@/lib/bookkeeping/accruals/service'
import type { AccrualSchedule, AccrualScheduleInstallment } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

const CreateBodySchema = CreateManualAccrualFields.extend({
  dry_run: z.boolean().optional(),
}).refine(createNamesPeriod, CREATE_NEEDS_A_PERIOD)

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

/**
 * POST /api/bookkeeping/accruals
 *
 * "Ny periodisering": a periodisering set up by hand from a posted verifikat
 * or the ingående balans. { dry_run: true } answers the months and what
 * remains to spread, and writes nothing; the dialog shows it before the user
 * confirms. The rules live in createManualAccrualSchedule, the same service
 * the v1 endpoint and gnubok_create_accrual_schedule run (operation
 * accrual-schedules.create).
 */
export const POST = withRouteContext(
  'accruals.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateBodySchema)
    if (!validation.success) return validation.response
    const { dry_run: dryRun, ...input } = validation.data
    const outcome = await accrualSchedulesCreate.run(
      { supabase, companyId, userId: user.id, log },
      input,
      { dryRun: dryRun === true },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    log.info('manual accrual schedule created', { userId: user.id, companyId, scheduleId: outcome.data.accrual_schedule_id })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
