import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '@/lib/rate-limits/agent'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getAiStatus } from '@/lib/ai'
import { answerAssistantQuestion } from '@/lib/agent/ask/ask-service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/agent/ask: a single-call, provider-agnostic assistant answer.
 *
 * Unlike POST /api/agent/invoke (the streaming Anthropic chat runtime, which
 * is gated on `assistantAvailable` and only runs on the Anthropic family),
 * this endpoint uses getAiService().generateText, so it runs on ANY configured
 * backend, including an OpenAI-compatible local model. It is therefore gated
 * on `configured`, not `assistantAvailable`. This is the replacement chat
 * surface's server side (audit Option A / rip): a page posts its context and
 * a question, gets one answer back.
 */

const Schema = z.object({
  question: z.string().min(1).max(4000),
  context: z.string().max(24_000).optional(),
  tier: z.enum(['assistant', 'heavy']).optional(),
  company_id: z.string().uuid().optional(),
})

export async function POST(request: Request): Promise<Response> {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  const rate = await checkAgentRateLimit(supabase, user.id)
  if (!rate.ok) return NextResponse.json(agentRateLimitResponseBody(rate), { status: 429 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ogiltig fråga.', type: 'validation_error' }, { status: 400 })
  }

  const companyId = parsed.data.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
  if (capBlocked) return capBlocked

  // Distinct from the paywall: no AI backend configured at all. Unlike the
  // chat loop, ANY provider works here, so we gate on `configured`.
  if (!getAiStatus().configured) {
    return NextResponse.json(
      { error: 'Assistenten är inte konfigurerad på den här installationen.', code: 'ai_unconfigured' },
      { status: 503 },
    )
  }

  try {
    const result = await answerAssistantQuestion({
      supabase,
      companyId,
      question: parsed.data.question,
      pageContext: parsed.data.context,
      tier: parsed.data.tier,
    })
    return NextResponse.json({ data: result })
  } catch (err) {
    return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
  }
}
