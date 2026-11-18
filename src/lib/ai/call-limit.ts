import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'
import type { AiService } from './types'

/**
 * How long one structured answer or one document reading may take, the SDK's
 * own retries included, when the caller set no limit of its own. Without it
 * the only limit was the SDK's default: ten minutes a try, three tries, in
 * functions Vercel ends at 300 s. A call that hangs then takes its whole run
 * with it (seen over 30 days to 2026-11-12: documents/classify/cron killed at
 * 300 s 18 times, documents/read/cron once, documents/jobs/cron seen at
 * 242 s). Two minutes is far above a healthy call (a classification answers
 * in seconds, a dense scanned page in well under a minute) and leaves a
 * 300 s run room to record what happened.
 *
 * The default: AI_CALL_TIMEOUT_SECONDS overrides it (lib/ai/config.ts), for a
 * self-hosted model that answers slower than a hosted one. A caller whose one
 * call is known to need more passes its own signal.
 */
export const AI_CALL_LIMIT_MS = 120_000

// One scope per process, not per module copy (lib/global-singleton.ts): a
// cron route opens it, and the code that calls the model a few layers down
// reads it through its own copy of this module.
const scope = globalSingleton('aiDeadlineScope', () => new AsyncLocalStorage<number>())

/**
 * Every model call made inside fn ends by `deadlineAt` (epoch ms), whatever
 * limit of its own it has. For a run with a hard stop: a scheduled job passes
 * the moment its function must be done with the model, so a call started late
 * gets what is left of the run instead of a full limit, and a document that
 * needs many calls (a long scan, read page by page) cannot outlive the run
 * either. A call that would start after the deadline fails at once. A scope
 * opened inside another never reaches past the outer one.
 */
export function withAiDeadline<T>(deadlineAt: number, fn: () => Promise<T>): Promise<T> {
  return scope.run(Math.min(deadlineAt, currentAiDeadline() ?? Infinity), fn)
}

/** The deadline of the surrounding withAiDeadline, if any. */
export function currentAiDeadline(): number | undefined {
  return scope.getStore()
}

/**
 * What a call cut by its run's deadline says in its message. The message is
 * what survives where a failure is kept as text (a job's last_error, a read
 * outcome's reason), so this is how the job queue tells the two cuts apart.
 */
const RUN_DEADLINE_CUT = "the run's time was up"

/** Whether a failure, as an error or as its stored text, is a call cut by the run's deadline rather than by its own limit. */
export function isRunDeadlineCut(failure: unknown): boolean {
  const text = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : ''
  return text.includes(RUN_DEADLINE_CUT)
}

/**
 * The call was ended by a time limit. Says nothing about the request itself:
 * classifyExtractionError (lib/documents/inbox-extraction) reads it as the
 * provider being unavailable, so the document stays unread or untyped and is
 * tried again.
 *
 * `cut` says which limit: 'call_limit' is the call's own (the model gave no
 * answer in the time one call gets, which is the provider's doing), and
 * 'run_deadline' is the surrounding withAiDeadline (the run ended first,
 * which says the work did not fit in what was left of the run, not that the
 * provider is down).
 */
export class AiCallTimeoutError extends Error {
  readonly code = 'AI_CALL_TIMEOUT'
  constructor(
    readonly cut: 'call_limit' | 'run_deadline',
    limitMs: number,
    cause?: unknown,
  ) {
    const seconds = Math.round(limitMs / 1000)
    super(
      cut === 'call_limit'
        ? `Request timed out: no answer from the model within ${seconds} s`
        : limitMs > 0
          ? `Request timed out: ${RUN_DEADLINE_CUT} ${seconds} s into the model call`
          : `Request timed out: ${RUN_DEADLINE_CUT} before the model was asked`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'AiCallTimeoutError'
  }
}

/** What a call ended by its caller's own signal rejects with: the signal's reason, as fetch does. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Request was aborted.')
}

/**
 * Run one service call under its limit: `ownLimitMs` unless the caller brought
 * a signal (it has set its own limit, e.g. the inbox reading's 250 s), and
 * never past the surrounding withAiDeadline. The call gets a signal that
 * fires at the limit, and the wait for it ends at the limit whether or not
 * the call has noticed, for a limit of ours and for the caller's own signal
 * alike: the SDK sleeps between its retries without watching the signal, so a
 * call left to end by itself could outlive its limit by that sleep. A call cut
 * by a limit of ours rejects with AiCallTimeoutError; one cut by the caller's
 * own signal rejects with that signal's reason, or as the service threw it.
 */
async function limited<T>(
  callerSignal: AbortSignal | undefined,
  ownLimitMs: number | null,
  call: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const deadlineAt = currentAiDeadline()
  const untilDeadline = deadlineAt === undefined ? Infinity : deadlineAt - Date.now()
  const ownMs = callerSignal || ownLimitMs === null ? Infinity : ownLimitMs
  const limitMs = Math.min(ownMs, untilDeadline)
  // Nothing bounds this call: no limit of its own, no signal and no run around it (a text answer outside a run).
  if (limitMs === Infinity && !callerSignal) return call(undefined)
  const cut = untilDeadline <= ownMs ? 'run_deadline' : 'call_limit'
  if (limitMs <= 0) throw new AiCallTimeoutError(cut, 0)
  if (callerSignal?.aborted) throw abortReason(callerSignal)

  const ours = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopListening = () => {}
  const ended = new Promise<never>((_resolve, reject) => {
    if (limitMs !== Infinity) {
      timer = setTimeout(() => {
        ours.abort()
        reject(new AiCallTimeoutError(cut, limitMs))
      }, limitMs)
    }
    if (callerSignal) {
      const onAbort = () => reject(abortReason(callerSignal))
      callerSignal.addEventListener('abort', onAbort, { once: true })
      stopListening = () => callerSignal.removeEventListener('abort', onAbort)
    }
  })
  const signal = limitMs === Infinity ? callerSignal : callerSignal ? AbortSignal.any([callerSignal, ours.signal]) : ours.signal
  const answer = call(signal)
  // Whichever loses the race still settles later (the call rejecting on its aborted signal): expected, not unhandled.
  answer.catch(() => undefined) // the race below reports how the call ended
  ended.catch(() => undefined) // the race below reports the limit or the caller's abort
  try {
    return await Promise.race([answer, ended])
  } catch (err) {
    if (ours.signal.aborted && !callerSignal?.aborted && !(err instanceof AiCallTimeoutError)) throw new AiCallTimeoutError(cut, limitMs, err)
    throw err
  } finally {
    clearTimeout(timer)
    stopListening()
  }
}

/**
 * The service every caller gets, with a time limit on each call (getAiService
 * wraps both backends in it). One place, so a new feature is bounded the day
 * it ships, the same way it is metered.
 *
 * generateStructured and extractFromDocument get `limitMs` (the configured
 * AI_CALL_LIMIT_MS). generateText has no limit of its own: one call is a
 * whole tool loop (several model turns and the tools between them) that a
 * person is waiting on, and how long that may take is its caller's to say.
 * All three end at a surrounding withAiDeadline.
 */
export function withCallLimit(service: AiService, limitMs: number = AI_CALL_LIMIT_MS): AiService {
  return {
    get provider() {
      return service.provider
    },
    get capabilities() {
      return service.capabilities
    },
    modelFor: (tier) => service.modelFor(tier),
    generateText: (req) => limited(req.signal, null, (signal) => service.generateText(signal ? { ...req, signal } : req)),
    generateStructured: (req) =>
      limited(req.signal, limitMs, (signal) => service.generateStructured(signal ? { ...req, signal } : req)),
    extractFromDocument: (req) =>
      limited(req.signal, limitMs, (signal) => service.extractFromDocument(signal ? { ...req, signal } : req)),
  }
}
