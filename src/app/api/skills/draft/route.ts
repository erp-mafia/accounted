import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getAiService, getAiStatus } from '@/lib/ai'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '@/lib/rate-limits/agent'
import { draftCreatorStep, MAX_QUESTIONS } from '@/lib/agent-skills/creator-chat'

ensureInitialized()

/**
 * POST /api/skills/draft: the next step of the Skills creator conversation,
 * either one more follow-up question or the summary. Stateless: the client
 * sends the whole conversation each time and nothing is written. Saving the
 * finished skill goes through POST /api/skills as before.
 */
const DraftSchema = z.object({
  client: z.enum(['Claude', 'ChatGPT', 'Grok']),
  locale: z.enum(['sv', 'en']),
  description: z.string().trim().min(3).max(2000),
  turns: z.array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(1000) }).strict()).max(MAX_QUESTIONS),
  extra: z.array(z.string().trim().min(1).max(1000)).max(5).default([]),
  summarize: z.boolean().default(false),
}).strict()

export const POST = withRouteContext('skills.draft', async (request, { supabase, companyId, user, log }) => {
  const validation = await validateBody(request, DraftSchema)
  if (!validation.success) return validation.response

  const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
  if (capBlocked) return capBlocked
  if (!getAiStatus().configured) {
    return NextResponse.json({ error: { code: 'AI_UNCONFIGURED', message: 'Assistenten är inte konfigurerad på den här installationen.', message_en: 'The assistant is not configured on this installation.' } }, { status: 503 })
  }
  const rate = await checkAgentRateLimit(supabase, user.id)
  if (!rate.ok) return NextResponse.json({ error: { code: 'RATE_LIMITED', message: agentRateLimitResponseBody(rate).error, message_en: 'Too many requests, try again shortly.' } }, { status: 429 })

  try {
    const step = await draftCreatorStep(getAiService(), validation.data)
    return NextResponse.json({ data: step })
  } catch (err) {
    log.warn('skill draft failed', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: { code: 'DRAFT_FAILED', message: 'Assistenten svarade inte. Försök igen.', message_en: 'The assistant did not answer. Try again.' } }, { status: 502 })
  }
}, { requireWrite: true })
