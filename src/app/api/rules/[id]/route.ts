import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { UUID_RE } from '@/lib/invariants/uuid'
import { getRule, listRuleMatches, updateRule } from '@/lib/rules/service'
import { USER_SETTABLE_MODES } from '@/lib/rules/model'
import { readDirectBookingSettings } from '@/lib/transactions/direct-booking-settings'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/rules/[id]
 * One rule with this year's matches (booked transactions whose bank text
 * matches the counterparty or an alias), and the company's one-click switch.
 */
export const GET = withRouteContext<Params>('rule.get', async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Ogiltigt id' }, { status: 400 })
  try {
    const rule = await getRule(supabase, companyId, id)
    if (!rule) return NextResponse.json({ error: 'Regeln finns inte' }, { status: 404 })
    const [matches, direct_booking] = await Promise.all([
      listRuleMatches(supabase, companyId, rule),
      readDirectBookingSettings(supabase, companyId),
    ])
    return NextResponse.json({ data: { rule, matches, direct_booking } })
  } catch (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }
})

// 'auto' is on the ladder but not settable yet: the autopilot tier (rule-driven
// auto-commit under the autonomy envelope) ships separately. Until then a rule
// only moves between propose and paused.
const PatchSchema = z
  .object({
    mode: z.enum(['propose', 'paused', 'auto', 'proposed']).optional(),
    // accounted#130: the rule asks for a review on every booking, so its
    // suggestion never books with one click. Audited by the table's trigger.
    always_review: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.mode !== undefined || body.always_review !== undefined, {
    message: 'Ange mode eller always_review',
  })

/**
 * PATCH /api/rules/[id]
 * Move a rule on the ladder, or set whether it always asks for a review.
 * Body: { mode?: 'propose' | 'paused', always_review?: boolean }, at least one.
 */
export const PATCH = withRouteContext<Params>(
  'rule.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Ogiltigt id' }, { status: 400 })
    const parsed = await validateBody(request, PatchSchema)
    if (!parsed.success) return parsed.response
    if (parsed.data.mode !== undefined && !USER_SETTABLE_MODES.includes(parsed.data.mode)) {
      return NextResponse.json(
        { error: 'Läget "bokför själv" kommer med autopiloten. Just nu kan en regel föreslå eller vara pausad.' },
        { status: 400 },
      )
    }
    try {
      const rule = await updateRule(supabase, companyId, id, parsed.data)
      if (!rule) return NextResponse.json({ error: 'Regeln finns inte' }, { status: 404 })
      return NextResponse.json({ data: rule })
    } catch (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }
  },
  { requireWrite: true },
)
