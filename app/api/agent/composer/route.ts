import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
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
// Auth: must be a non-viewer member of the target company (it rewrites the
// company's agent_profile unless dry_run).
//
// Plan ref: dev_docs/specialized-agent-plan.md §6.
export const POST = withRouteContext('agent.composer.run', async (request, ctx) => {
  const { supabase, companyId: activeCompanyId, user } = ctx

  const rate = await checkAgentRateLimit(supabase, user.id)
  if (!rate.ok) {
    return NextResponse.json(agentRateLimitResponseBody(rate), {
      status: 429,
      headers: rate.retryAfterSec ? { 'Retry-After': String(rate.retryAfterSec) } : undefined,
    })
  }

  // Tolerant parse: ops callers POST with an empty body, which is valid here.
  const raw = await request.json().catch(() => ({}))
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        type: 'validation_error',
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
      { status: 400 },
    )
  }
  const body = parsed.data

  const companyId = body.company_id ?? activeCompanyId

  // Defense in depth alongside RLS: confirm membership before composing, and
  // require a non-viewer role: the composer rewrites agent_profiles.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) {
    return NextResponse.json(
      {
        error: {
          code: 'NOT_COMPANY_MEMBER',
          message: 'Du är inte medlem i detta företag.',
          message_en: 'Not a member of this company.',
        },
      },
      { status: 403 },
    )
  }
  if (membership.role === 'viewer') {
    return NextResponse.json(
      {
        error: {
          code: 'WRITE_PERMISSION_REQUIRED',
          message: 'Du har endast läsbehörighet i detta företag.',
          message_en: 'You only have read access in this company.',
        },
      },
      { status: 403 },
    )
  }

  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
  if (capBlocked) return capBlocked

  const composed = await composeAgentProfile(supabase, companyId, { dryRun: body.dry_run })
  return NextResponse.json({ data: composed })
})
