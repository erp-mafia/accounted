import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveCompanyId } from '@/lib/company/context'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '@/lib/rate-limits/agent'
import { composeAgentProfile } from '@/lib/agent/composer'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

const BodySchema = z.object({
  // Optional override; if absent we use the user's active_company_id.
  company_id: z.string().uuid().optional(),
  // dry_run=true returns the composed profile without writing to agent_profiles.
  dry_run: z.boolean().optional(),
})

// POST /api/agent/composer
//
// Runs the specialized accountant composer pipeline for a company:
//   1. Gathers TIC snapshot, optional SIE summary, optional banking summary.
//   2. Calls Opus 4.7 to select horizontal/vertical/modifier atoms.
//   3. Calls Sonnet 4.6 to write the Swedish profile_summary.
//   4. Persists to agent_profiles (skipped on dry_run).
//   5. Fires fire-and-forget cache pre-warm.
//
// Auth: must be a member of the target company.
//
// Plan ref: dev_docs/specialized-agent-plan.md §6.
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rate = await checkAgentRateLimit(supabase, user.id)
  if (!rate.ok) {
    return NextResponse.json(agentRateLimitResponseBody(rate), {
      status: 429,
      headers: rate.retryAfterSec ? { 'Retry-After': String(rate.retryAfterSec) } : undefined,
    })
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json().catch(() => ({})))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const companyId = body.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) {
    return NextResponse.json({ error: 'No active company' }, { status: 400 })
  }

  // Defense in depth alongside RLS: confirm membership before composing.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this company' }, { status: 403 })
  }

  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
  if (capBlocked) return capBlocked

  try {
    const composed = await composeAgentProfile(supabase, companyId, { dryRun: body.dry_run })
    return NextResponse.json({ data: composed })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Composer failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
