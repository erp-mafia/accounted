import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { getIntent } from '@/lib/agent/intents/registry'
import { checkAgentRateLimit, agentRateLimitResponseBody } from '@/lib/rate-limits/agent'
import { runChatTurn, friendlyModelError } from '@/lib/agent/chat/run-turn'
import { getAiStatus } from '@/lib/ai'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// Make sure extensions are loaded: the chat loop dispatches against the
// agent tool registry which is populated by the mcp-server extension at load.
ensureInitialized()

// Deep turns (thinking at high/xhigh effort, up to 12 tool iterations, a
// 15-27k-token prompt prefix) can outlive the plan default duration cap; a
// function killed mid-stream closes the NDJSON stream cleanly, which the chat
// used to render as silent success. 300 s matches the other long-running model
// surfaces (app/api/receipt-hunt/run, app/api/agent/ask).
export const maxDuration = 300

// Hard cap on the per-turn user input. Generous for a chat composer (about
// 5k words / 20 pages) but bounds Bedrock token cost if the rate limiter is
// ever fail-open and a client floods large payloads.
const MAX_USER_MESSAGE_LEN = 20_000

const BodySchema = z.object({
  intent_id: z.string().min(1).max(200),
  // Existing conversation to resume; if omitted, the route creates one. The
  // chat sheet's React state holds the conversation id as `string | null`
  // and serializes `null` on the first turn, so accept null alongside
  // undefined and treat both as "no existing conversation".
  conversation_id: z.string().uuid().nullable().optional(),
  // Optional company override; defaults to active_company_id.
  company_id: z.string().uuid().nullable().optional(),
  // The user's message (or, on the first turn, this is empty and we send the
  // intent's prompt template instead). Capped to bound LLM cost.
  user_message: z.string().max(MAX_USER_MESSAGE_LEN).nullable().optional(),
  // Intent-specific capture args (e.g. { transaction_id: '...' } for
  // transaction.categorization). Used only on the first turn to build the
  // prompt template. Each value is bounded so capture inputs can't be a
  // megabyte each; the dispatcher rejects oversize values upfront.
  intent_args: z
    .record(z.string().max(120), z.unknown())
    .nullable()
    .optional()
    .refine(
      (v) => {
        if (!v) return true
        try {
          return JSON.stringify(v).length <= MAX_USER_MESSAGE_LEN
        } catch {
          return false
        }
      },
      { message: 'intent_args too large' },
    ),
  // Optional context_ref for the conversation row, e.g. 'transaction:<id>'.
  context_ref: z.string().max(200).nullable().optional(),
  // When true (and user_message is provided), persist the turn but flag it
  // hidden so it doesn't render as a user bubble on resume. Used by the chat's
  // rejection-correction flow (ApprovalCard → AgentChat) to feed the agent a
  // synthetic correction without showing it as something the user typed.
  user_message_hidden: z.boolean().nullable().optional(),
})

// POST /api/agent/invoke
//
// Streams NDJSON events from the chat loop. Each line is a JSON object whose
// `kind` identifies the event type: see lib/agent/chat/run-turn.ts StreamEvent.
//
// Auth: the user must be a member of the resolved company.
//
// Plan ref: dev_docs/specialized-agent-plan.md §9 (chat loop).
export async function POST(request: Request) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  // Generous per-user rate limit: bounds runaway Bedrock spend (loop-firing
  // sessions). Fails open on infra error.
  const rate = await checkAgentRateLimit(supabase, user.id)
  if (!rate.ok) {
    return NextResponse.json(agentRateLimitResponseBody(rate), {
      status: 429,
      headers: rate.retryAfterSec ? { 'Retry-After': String(rate.retryAfterSec) } : undefined,
    })
  }

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Invalid body' },
      { status: 400 },
    )
  }

  const intent = getIntent(body.intent_id)
  if (!intent) {
    return NextResponse.json({ error: `Unknown intent: ${body.intent_id}` }, { status: 400 })
  }

  const companyId = body.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // No Anthropic Bedrock calls in the sandbox: the demo runs entirely on
  // seed data and the assistant is gated to a "look, don't touch" preview.
  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.ai)
  if (capBlocked) return capBlocked

  // Distinct from the paywall: the deployment has no AI backend the chat
  // loop can run on (no credentials, or an OpenAI-compatible endpoint, which
  // the loop does not speak yet). Answer up front instead of opening a
  // stream that dies on the first model call.
  if (!getAiStatus().assistantAvailable) {
    return NextResponse.json(
      {
        error: 'Assistenten är inte konfigurerad på den här installationen.',
        code: 'ai_unconfigured',
      },
      { status: 503 },
    )
  }

  // Resolve the conversation BEFORE any side effect below (the onboarding
  // intake stamp): a request that is about to be rejected must not write.
  let conversationId = body.conversation_id ?? null
  if (conversationId) {
    // A resumed conversation id comes straight from the client, so ownership
    // has to be proven here. RLS on agent_conversations/agent_messages is
    // COMPANY-scoped (migration 20260517204000), not user-scoped, so RLS alone
    // would happily load a colleague's thread into the prompt and append this
    // user's turns to it. The conversations list route filters on user_id for
    // exactly this reason; the same rule applies to the turn itself.
    //
    // The company check matters too: a user who belongs to several companies
    // must not resume a thread from company B while the turn runs with company
    // A's ledger, tools and staged operations.
    const { data: conv } = await supabase
      .from('agent_conversations')
      .select('id, user_id, company_id, intent_id')
      .eq('id', conversationId)
      .maybeSingle()

    if (!conv || conv.user_id !== user.id || conv.company_id !== companyId) {
      // Same response for "doesn't exist" and "isn't yours": a 403 here would
      // confirm that someone else's conversation id is real.
      return NextResponse.json({ error: 'Konversationen hittades inte.' }, { status: 404 })
    }

    // The intent decides the tool loadout and the system prompt. Letting a
    // resumed thread switch intent mid-conversation would swap the tool
    // whitelist under history the model has already been shown.
    if (conv.intent_id !== body.intent_id) {
      return NextResponse.json(
        { error: 'Konversationen hör till ett annat sammanhang.' },
        { status: 400 },
      )
    }
  }

  // onboarding.intake completion signal: once the user has actually
  // engaged (typed a real reply, not the auto-fired greeting prompt that
  // mounts the chat), stamp intake_completed_at on the profile so re-entry
  // logic and opportunistic follow-up logic in other intents can tell the
  // intake happened. Idempotent: the IS NULL guard ensures we never
  // overwrite the first engagement timestamp. Best-effort: failure here
  // doesn't break the chat; the next user turn retries.
  if (
    body.intent_id === 'onboarding.intake' &&
    typeof body.user_message === 'string' &&
    body.user_message.trim().length > 0 &&
    body.user_message_hidden !== true
  ) {
    try {
      await supabase
        .from('agent_profiles')
        .update({ intake_completed_at: new Date().toISOString() })
        .eq('company_id', companyId)
        .is('intake_completed_at', null)
    } catch {
      // ignored: see comment above
    }
  }

  // Load lightweight company + user signals for the system prompt.
  const [{ data: company }, { data: profile }] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).single(),
    supabase.from('profiles').select('full_name').eq('id', user.id).single(),
  ])
  const companyName = company?.name ?? ''
  const firstName = profile?.full_name?.split(' ')[0] ?? null

  // Create the conversation row when this is a fresh thread.
  if (!conversationId) {
    const { data: newConv, error: convErr } = await supabase
      .from('agent_conversations')
      .insert({
        company_id: companyId,
        user_id: user.id,
        intent_id: body.intent_id,
        context_ref: body.context_ref ?? null,
        title: intent.sheetTitle,
      })
      .select('id')
      .single()
    if (convErr || !newConv) {
      return NextResponse.json(
        { error: getUserErrorMessage(convErr) ?? 'Failed to create conversation' },
        { status: 500 },
      )
    }
    conversationId = newConv.id as string
  }

  // Compute the user message to send to Anthropic. On the first turn (no
  // user_message provided), we run the intent's capture + promptTemplate
  // pipeline so the prompt is anchored on the page context the user
  // clicked from.
  let effectiveUserMessage = body.user_message ?? ''
  // When the caller didn't supply a user_message, we synthesize one from the
  // intent's promptTemplate. Mark that synthetic turn hidden so the UI
  // doesn't render the template scaffolding as a user bubble on resume. The
  // client can also explicitly request a hidden turn (rejection correction)
  // even when it DID supply a user_message.
  let userMessageHidden = body.user_message_hidden === true
  // Set on a first turn, where the prompt template needs it anyway; handed to
  // runChatTurn so the system prompt reuses it instead of re-reading.
  let preloadedProfileSummary: string | null | undefined
  if (!effectiveUserMessage) {
    try {
      const captured = await intent.capture(body.intent_args ?? {}, {
        supabase,
        userId: user.id,
        companyId,
      })
      const [profileSummary, memory] = await Promise.all([
        loadProfileSummary(supabase, companyId),
        loadRankedMemory(supabase, companyId, 30),
      ])
      effectiveUserMessage = intent.promptTemplate({
        captured,
        profileSummary,
        activeMemory: memory,
      })
      // Hand it to the turn so it doesn't re-read it for the system prompt.
      preloadedProfileSummary = profileSummary
      userMessageHidden = true
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? `Capture failed: ${getUserErrorMessage(err)}`
              : 'Capture failed',
        },
        { status: 500 },
      )
    }
  }

  // Stream: NDJSON events from the chat loop.
  const encoder = new TextEncoder()
  // Conversation id is set above; capture into a non-null local for the
  // streaming closure's first emission.
  const convId: string = conversationId

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: unknown): boolean => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          return true
        } catch {
          return false
        }
      }

      // Surface the conversation id so the client can resume with it.
      emit({ kind: 'conversation', conversation_id: convId })

      try {
        await runChatTurn({
          supabase,
          userId: user.id,
          companyId,
          companyName,
          firstName,
          intent,
          conversationId: convId,
          userMessage: effectiveUserMessage,
          userMessageHidden,
          persist: true,
          preloadedProfileSummary,
          emit: (event) => emit(event),
        })
      } catch (err) {
        // run-turn already emitted a friendly error before re-throwing; emit a
        // normalized one here too so this outer catch never overwrites it with a
        // raw AWS SDK string.
        emit({
          kind: 'error',
          message: friendlyModelError(err),
        })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

async function loadProfileSummary(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('agent_profiles')
    .select('profile_summary')
    .eq('company_id', companyId)
    .maybeSingle()
  return (data?.profile_summary as string | null) ?? null
}

async function loadRankedMemory(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  cap: number,
): Promise<{ content: string; kind: string }[]> {
  const { data } = await supabase
    .from('agent_memory')
    .select('content, kind, relevance_score, last_accessed_at')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('relevance_score', { ascending: false })
    .order('last_accessed_at', { ascending: false, nullsFirst: false })
    .limit(cap)
  return (data ?? []).map((r: { content: string; kind: string }) => ({
    content: r.content,
    kind: r.kind,
  }))
}
