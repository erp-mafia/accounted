import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { UUID_RE } from '@/lib/invariants/uuid'
import { getRule, listRuleMatches, setRuleMode } from '@/lib/rules/service'
import { USER_SETTABLE_MODES } from '@/lib/rules/model'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/rules/[id]
 * One rule with this year's matches (booked transactions whose bank text
 * matches the counterparty or an alias).
 */
export const GET = withRouteContext<Params>('rule.get', async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Ogiltigt id' }, { status: 400 })
  try {
    const rule = await getRule(supabase, companyId, id)
    if (!rule) return NextResponse.json({ error: 'Regeln finns inte' }, { status: 404 })
    const matches = await listRuleMatches(supabase, companyId, rule)
    return NextResponse.json({ data: { rule, matches } })
  } catch (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }
})

// 'auto' is on the ladder but not settable yet: the autopilot tier (rule-driven
// auto-commit under the autonomy envelope) ships separately. Until then a rule
// only moves between propose and paused.
const PatchSchema = z
  .object({
    mode: z.enum(['propose', 'paused', 'auto', 'proposed']),
  })
  .strict()

/**
 * PATCH /api/rules/[id]
 * Move a rule on the ladder. Body: { mode: 'propose' | 'paused' }.
 */
export const PATCH = withRouteContext<Params>(
  'rule.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Ogiltigt id' }, { status: 400 })
    const parsed = await validateBody(request, PatchSchema)
    if (!parsed.success) return parsed.response
    if (!USER_SETTABLE_MODES.includes(parsed.data.mode)) {
      return NextResponse.json(
        { error: 'Läget "bokför själv" kommer med autopiloten. Just nu kan en regel föreslå eller vara pausad.' },
        { status: 400 },
      )
    }
    try {
      const rule = await setRuleMode(supabase, companyId, id, parsed.data.mode)
      if (!rule) return NextResponse.json({ error: 'Regeln finns inte' }, { status: 404 })
      return NextResponse.json({ data: rule })
    } catch (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }
  },
  { requireWrite: true },
)
