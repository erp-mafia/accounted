import type { Locale } from '@/i18n/config'

/**
 * Typed failure for "the model returned no visible text", even after the tool
 * loop's final answer turn: stop_reason max_tokens with the whole budget spent
 * before the first text block, or a refusal with an empty body. Before this
 * existed, an empty answer flowed through /api/agent/ask as a 200 and rendered
 * as an invisible bubble ("Tänker", then silence).
 *
 * Lives in its own module so the API route and its tests can match on it
 * without importing ask-service's full dependency graph.
 */
export class EmptyModelAnswerError extends Error {
  readonly code = 'empty_model_answer'
  /** The last turn hit max_tokens: the question needed more than one answer holds. */
  readonly truncated: boolean

  constructor(model: string, opts: { truncated?: boolean } = {}) {
    super(`Model ${model} returned an empty answer`)
    this.name = 'EmptyModelAnswerError'
    this.truncated = opts.truncated === true
  }
}

// The answer's language follows the UI locale (lib/agent/reply-language.ts),
// so the sentences the route and the service add around it do too. The route
// sends them as `error`, which AskConsole renders verbatim.
const MESSAGES = {
  empty: {
    sv: 'Assistenten gav inget svar. Försök igen.',
    en: 'The assistant gave no answer. Please try again.',
  },
  emptyTruncated: {
    sv: 'Frågan krävde mer än assistenten får plats med i ett svar. Försök med en smalare fråga, till exempel en viss period eller ett visst konto.',
    en: 'The question needed more than the assistant can fit in one answer. Try a narrower question, for example one period or one account.',
  },
  truncatedNote: {
    sv: '(Svaret avbröts eftersom det blev för långt. Ställ en smalare fråga för resten.)',
    en: '(The answer was cut off because it got too long. Ask a narrower question for the rest.)',
  },
  providerUnavailable: {
    sv: 'AI-tjänsten är tillfälligt otillgänglig. Försök igen om en stund.',
    en: 'The AI service is temporarily unavailable. Please try again in a moment.',
  },
} as const

function pick(m: { sv: string; en: string }, locale: Locale | undefined): string {
  return locale === 'en' ? m.en : m.sv
}

/** What the user is told when no answer came back at all. */
export function emptyAnswerMessage(err: EmptyModelAnswerError, locale?: Locale): string {
  return pick(err.truncated ? MESSAGES.emptyTruncated : MESSAGES.empty, locale)
}

/** Appended to an answer that was cut off at max_tokens, so a half answer never reads as a whole one. */
export function truncatedAnswerNote(locale?: Locale): string {
  return pick(MESSAGES.truncatedNote, locale)
}

/** What the user is told when the AI provider itself failed (outage, throttling) after the SDK's own retries. */
export function providerUnavailableMessage(locale?: Locale): string {
  return pick(MESSAGES.providerUnavailable, locale)
}

/**
 * True when the model provider, not our code, failed the call: a 5xx (Bedrock
 * "503 unable to process your request", Anthropic 529 overloaded), a 429
 * throttle, or no connection at all. The SDK clients already retried these
 * (maxRetries 2), so what reaches the route is an outage the user can only
 * wait out. Duck-typed on the status so it covers the Bedrock and direct
 * Anthropic clients (`status`) and the Vercel AI SDK (`statusCode`) alike.
 */
export function isAiProviderUnavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; statusCode?: unknown; name?: unknown }
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null
  if (status !== null) return status === 429 || status >= 500
  return e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError'
}
