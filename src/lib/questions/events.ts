/**
 * The question list's events: one per write that files, answers, closes or
 * reopens a question (lib/events/types.ts, company_question.*). Each carries
 * the company and the question by id and the question's state after the
 * write (status, door, close reason, timestamps), never their text. They are
 * public events (lib/webhooks/public-events.ts): what a payload carries here
 * is what a webhook receiver and the event feed get, minus the user id.
 *
 * The write has already happened when its event is emitted, so an emit that
 * fails is logged and the write stands.
 */
import { eventBus } from '@/lib/events'
import type { CoreEvent } from '@/lib/events/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('questions')

export type QuestionEvent = Extract<
  CoreEvent,
  { type: 'company_question.filed' | 'company_question.answered' | 'company_question.closed' | 'company_question.reopened' }
>

/** Emits the event and waits for its handlers. Never throws. */
export async function emitQuestionEvent(event: QuestionEvent): Promise<void> {
  try {
    await eventBus.emit(event)
  } catch (error: unknown) {
    log.warn('a question event was not delivered', {
      eventType: event.type,
      companyId: event.payload.companyId,
      questionId: event.payload.questionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
