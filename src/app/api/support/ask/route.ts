import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getAiStatus, isAiSwitchedOffError } from '@/lib/ai'
import { guardSandbox } from '@/lib/sandbox/guard'
import { eventBus } from '@/lib/events/bus'
import {
  EmptyModelAnswerError,
  emptyAnswerMessage,
  isAiProviderUnavailable,
  providerUnavailableMessage,
} from '@/lib/agent/ask/errors'
import { loadChatHistory, persistAssistantTurn, persistUserTurn } from '@/lib/agent/ask/persist'
import { answerSupportQuestion } from '@/lib/agent/support/service'
import { resolveSupportConversation } from '@/lib/agent/support/conversation'
import { loadPageTextIndex, matchRoute } from '@/lib/agent/support/page-texts'
import { checkSupportRateLimit, SUPPORT_DAY_LIMIT_MESSAGE } from '@/lib/agent/support/rate-limit'
import { isSupportAssistantEnabled } from '@/lib/agent/support/rollout'
import { encodeSupportEvent, type SupportStreamEvent } from '@/lib/support/assistant-stream'
import { SUPPORTED_LOCALES, type Locale } from '@/i18n/config'

// An answer is a tool loop (page reads, ledger reads, then the text): the
// same ceiling as the other long model routes (app/api/agent/ask).
export const maxDuration = 300

/**
 * POST /api/support/ask: one question to the support assistant, answered as
 * a stream (lib/support/assistant-stream.ts).
 *
 * Who may ask: any member of a company the assistant is switched on for
 * (SUPPORT_ASSISTANT_COMPANY_IDS, lib/agent/support/rollout.ts), on trial and
 * on every plan. There is no plan gate and no built assistant to have first:
 * this is support, not the paid chat. The invoicing-only role is refused by
 * withRouteContext (the route is not on its list: the assistant reads the
 * whole company), the sandbox by guardSandbox, and a company that switched
 * AI off by the AI layer itself.
 *
 * What it can do: read. The assistant gets the company's menu, the texts on
 * its pages and the read-only ledger tools; no write or staging tool exists
 * on this route.
 */
const BodySchema = z.object({
  question: z.string().trim().min(1).max(4000),
  // The conversation an earlier answer started; omitted or null starts one.
  conversation_id: z.string().uuid().nullable().optional(),
  // The page the user asked from. A path, never a URL.
  route: z.string().max(300).regex(/^\/\S*$/).optional(),
  // The UI locale: the answer's language and the labels it quotes.
  locale: z.enum(SUPPORTED_LOCALES).optional(),
})

/** What the user is told when the answer failed after the stream began. */
function failure(err: unknown, locale: Locale | undefined): { message: string; code: string } {
  if (err instanceof EmptyModelAnswerError) return { message: emptyAnswerMessage(err, locale), code: 'empty_model_answer' }
  if (isAiProviderUnavailable(err)) return { message: providerUnavailableMessage(locale), code: 'ai_provider_unavailable' }
  return { message: getUserErrorMessage(err), code: 'support_answer_failed' }
}

export const POST = withRouteContext('support.ask', async (request, ctx) => {
  const { supabase, companyId, user, log } = ctx

  if (!isSupportAssistantEnabled(companyId)) return errorResponseFromCode('SUPPORT_ASSISTANT_OFF', log)

  const validation = await validateBody(request, BodySchema, { log, operation: 'support.ask' })
  if (!validation.success) return validation.response
  const body = validation.data
  const locale = body.locale

  const blocked = await guardSandbox(supabase, companyId)
  if (blocked) return blocked

  if (!getAiStatus().configured) return errorResponseFromCode('SUPPORT_ASSISTANT_UNCONFIGURED', log)

  // After the checks that cost nothing, so a refused request does not count
  // against the limit, and before anything is written or sent to the model.
  const rate = await checkSupportRateLimit(supabase, user.id)
  if (!rate.ok) {
    return errorResponseFromCode(
      'SUPPORT_ASSISTANT_RATE_LIMITED',
      log,
      rate.scope === 'day'
        ? { messageSv: SUPPORT_DAY_LIMIT_MESSAGE.sv, messageEn: SUPPORT_DAY_LIMIT_MESSAGE.en }
        : {},
    )
  }

  // The thread first: a bad conversation id is answered before a model call,
  // and the question is stored before the answer is asked for, so a failed
  // answer still leaves the question in the thread.
  const resolved = await resolveSupportConversation(
    supabase,
    user.id,
    companyId,
    body.conversation_id,
    body.question,
    body.route,
  )
  if (!resolved.ok) return errorResponseFromCode('SUPPORT_ASSISTANT_CONVERSATION_NOT_FOUND', log)
  const { conversationId } = resolved
  const history = resolved.created ? [] : await loadChatHistory(supabase, conversationId)
  await persistUserTurn(supabase, conversationId, body.question)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (event: SupportStreamEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(encodeSupportEvent(event)))
        } catch {
          // The reader left (the dialog was closed): the answer is still
          // finished and stored below, nothing more is sent.
          open = false
        }
      }
      send({ type: 'start', conversation_id: conversationId })
      try {
        const result = await answerSupportQuestion({
          supabase,
          companyId,
          userId: user.id,
          conversationId,
          question: body.question,
          route: body.route,
          locale,
          history,
          onProgress: (event) => send(event),
        })
        await persistAssistantTurn(supabase, conversationId, result.answer)

        if (result.handoff) {
          // The record of what the assistant could not help with, where the
          // product team already reads feedback (event_log, agent.feedback).
          // No words of the user's or the model's: the reason, the page as
          // its route pattern, and the conversation to read them in.
          const index = loadPageTextIndex()
          const page = body.route ? ((index && matchRoute(index, body.route)) ?? 'en sida utanför menyn') : 'okänd sida'
          await eventBus.emit({
            type: 'agent.feedback',
            payload: {
              context: `Supportassistenten hänvisade till en människa (${result.handoff.reason}) från ${page}.`,
              sentiment: 'neutral',
              suggestion: null,
              toolName: null,
              skillSlug: null,
              sessionId: conversationId,
              actorType: 'user',
              actorId: user.id,
              actorLabel: null,
              userId: user.id,
              companyId,
            },
          })
        }
        send({ type: 'done', answer: result.answer, handoff: result.handoff })
      } catch (err) {
        if (isAiSwitchedOffError(err)) {
          const entry = getErrorEntry('SUPPORT_ASSISTANT_AI_SWITCHED_OFF')
          send({
            type: 'error',
            code: 'SUPPORT_ASSISTANT_AI_SWITCHED_OFF',
            message: (locale === 'en' ? entry?.message_en : entry?.message_sv) ?? getUserErrorMessage(err),
          })
        } else {
          const failed = failure(err, locale)
          if (failed.code === 'ai_provider_unavailable') log.warn('support assistant provider unavailable', { companyId })
          else if (failed.code === 'support_answer_failed') log.error('support answer failed', err, { companyId })
          send({ type: 'error', ...failed })
        }
      } finally {
        if (open) {
          try {
            controller.close()
          } catch {
            // Already closed by the reader.
          }
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
})
