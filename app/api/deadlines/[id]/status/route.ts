import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { updateDeadlineStatus, isValidTransition } from '@/lib/deadlines/status-engine'
import type { DeadlineStatus } from '@/types'

const ALL_STATUSES = [
  'upcoming',
  'action_needed',
  'in_progress',
  'submitted',
  'confirmed',
  'overdue',
] as const satisfies readonly DeadlineStatus[]

const PatchStatusSchema = z.object({
  status: z.enum(ALL_STATUSES),
})

/**
 * PATCH /api/deadlines/[id]/status
 * Manually update a deadline's status
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.set_status',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log } = ctx

    const validation = await validateBody(request, PatchStatusSchema, {
      log,
      operation: 'deadline.set_status',
    })
    if (!validation.success) return validation.response

    const result = await updateDeadlineStatus(supabase, id, companyId, validation.data.status)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

/**
 * GET /api/deadlines/[id]/status
 * Get current status and valid transitions
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.get_status',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { data: deadline, error } = await supabase
      .from('deadlines')
      .select('status, is_completed, due_date')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error || !deadline) {
      return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
    }

    // Calculate valid transitions from current status
    const validTransitions = ALL_STATUSES.filter((status) =>
      isValidTransition(deadline.status, status)
    )

    return NextResponse.json({
      currentStatus: deadline.status,
      isCompleted: deadline.is_completed,
      dueDate: deadline.due_date,
      validTransitions,
    })
  },
)
