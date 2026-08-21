import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '@/lib/rate-limits/agent'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getAiStatus } from '@/lib/ai'
import { answerAssistantQuestion } from '@/lib/agent/ask/ask-service'
import {
  resolveChatConversation,
  persistUserTurn,
  persistAssistantTurn,
} from '@/lib/agent/ask/persist'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// The assistant answers over the read-only MCP tools, which are registered
// into the agent tool registry by the mcp-server extension at load. Without
// this the registry is empty and the assistant falls back to snapshot-only,
// so a hosted deploy would silently lose its ledger tools.
ensureInitialized()

/**
 * POST /api/agent/ask: a single-call, provider-agnostic assistant answer over a
 * bounded read-only tool loop.
 *
 * Unlike POST /api/agent/invoke (the streaming Anthropic chat runtime, which
 * is gated on `assistantAvailable` and only runs on the Anthropic family),
 * this endpoint answers through getAiService().generateText, so it runs on ANY
 * configured backend, including an OpenAI-compatible local model. It is
 * therefore gated on `configured`, not `assistantAvailable`. The service
 * attaches the read-only MCP tools so it can fetch real figures (audit Option
 * A / rip): a page posts its context and a question, gets one answer back.
 */

const Schema = z.object({
  question: z.string().min(1).max(4000),
  context: z.string().max(24_000).optional(),
  tier: z.enum(['assistant', 'heavy']).optional(),
  company_id: z.string().uuid().optional(),
  // Chat-console persistence (opt-in). When `persist` is true, the turn is
  // written to agent_conversations/agent_messages so the /chat sidebar keeps
  // working. Page-scoped one-off actions (a report page asking a question)
  // omit it and stay stateless. `conversation_id` resumes an existing
  // general.help thread; omitted means "create one". `context_ref` binds a
  // fresh thread to a page ("report:vat:2026-07") for the context chip.
  persist: z.boolean().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
  context_ref: z.string().max(200).nullable().optional(),
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

  // Stateless page-scoped ask: one answer, nothing written.
  if (parsed.data.persist !== true) {
    try {
      const result = await answerAssistantQuestion({
        supabase,
        companyId,
        userId: user.id,
        question: parsed.data.question,
        pageContext: parsed.data.context,
        tier: parsed.data.tier,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
    }
  }

  // Persisted chat-console turn: resolve/create the thread, write the question,
  // answer once, write the answer. Resolve BEFORE the model call so a bad
  // conversation id 404s without spending a request; the user turn is written
  // before the answer so a mid-call failure still leaves the question in the
  // thread (the user can retry), matching the streaming runtime's semantics.
  try {
    const resolved = await resolveChatConversation(
      supabase,
      user.id,
      companyId,
      parsed.data.conversation_id,
      parsed.data.question,
      parsed.data.context_ref,
    )
    if (!resolved.ok) {
      return NextResponse.json({ error: 'Konversationen hittades inte.' }, { status: 404 })
    }
    const { conversationId } = resolved

    await persistUserTurn(supabase, conversationId, parsed.data.question)

    const result = await answerAssistantQuestion({
      supabase,
      companyId,
      userId: user.id,
      conversationId,
      question: parsed.data.question,
      pageContext: parsed.data.context,
      tier: parsed.data.tier,
    })

    await persistAssistantTurn(supabase, conversationId, result.answer)

    return NextResponse.json({ data: { ...result, conversation_id: conversationId } })
  } catch (err) {
    return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
  }
}
