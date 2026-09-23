import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'

// The event bus is a module-level singleton and extension handlers are wired
// by this call. Without it at module level the emit below goes nowhere and the
// vote is silently dropped, which is exactly the failure this route exists to
// fix.
ensureInitialized()

// POST /api/agent/feedback
//
// A thumbs-up or thumbs-down on one assistant answer.
//
// The buttons have existed since the message-actions pass but were wired to
// nothing: they animated, and the vote died in component state. An affordance
// that looks like it reports something and does not is worse than no
// affordance, because it spends the user's goodwill once and silently.
//
// This emits the SAME `agent.feedback` event the gnubok_feedback MCP tool
// emits, with actorType 'user'. The product team already queries event_log for
// that type, so votes from the chat land in the existing triage flow rather
// than in a second place someone has to remember to look at. That is also why
// there is no migration here: event_log takes the payload as jsonb and already
// treats agent.* as telemetry with the longer retention.

const BodySchema = z.object({
  conversation_id: z.string().uuid(),
  sentiment: z.enum(['positive', 'negative']),
  // Which answer, so a vote can be traced to the turn it was about.
  message_index: z.number().int().min(0).optional(),
})

export const POST = withRouteContext(
  'agent.feedback.create',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, BodySchema, {
      log,
      operation: 'agent.feedback.create',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    // The conversation id comes from the client, so it is checked the same way
    // /api/agent/invoke checks it: without this, any member could attach
    // feedback to another member's thread, and the triage backlog would carry
    // rows whose conversation the reporter never saw.
    const { data: conversation } = await supabase
      .from('agent_conversations')
      .select('id, user_id, company_id, intent_id')
      .eq('id', body.conversation_id)
      .maybeSingle()

    if (
      !conversation ||
      conversation.user_id !== user.id ||
      conversation.company_id !== companyId
    ) {
      return NextResponse.json(
        {
          error: {
            code: 'CONVERSATION_NOT_FOUND',
            message: 'Konversationen hittades inte.',
            message_en: 'Conversation not found.',
          },
        },
        { status: 404 },
      )
    }

    await eventBus.emit({
      type: 'agent.feedback',
      payload: {
        // Deliberately NOT free text. A comment box here would put whatever
        // the user typed, in an accounting product, verbatim into event_log
        // under telemetry retention: names, personnummer, client details. The
        // vote carries only what it needs to be actionable, which is the intent
        // and which answer it was about. If a comment field is ever wanted, it
        // needs its own data-classification and redaction decision first, made
        // with the UI in front of it rather than as an unused parameter.
        context: [
          `Chattbetyg på svar i ${conversation.intent_id}.`,
          body.message_index === undefined ? null : `(svar #${body.message_index})`,
        ]
          .filter(Boolean)
          .join(' '),
        sentiment: body.sentiment,
        suggestion: null,
        toolName: null,
        skillSlug: null,
        sessionId: conversation.id,
        actorType: 'user',
        actorId: user.id,
        actorLabel: null,
        userId: user.id,
        companyId,
      },
    })

    return NextResponse.json({ data: { recorded: true } })
  },
  { requireWrite: true },
)
