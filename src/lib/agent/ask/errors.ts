/**
 * Typed failure for "the model returned no visible text": stop_reason
 * max_tokens with the whole budget spent before the first text block, or a
 * refusal with an empty body. Before this existed, an empty answer flowed
 * through /api/agent/ask as a 200 and rendered as an invisible bubble
 * ("Tänker", then silence).
 *
 * Lives in its own module so the API route and its tests can match on it
 * without importing ask-service's full dependency graph.
 */
export class EmptyModelAnswerError extends Error {
  readonly code = 'empty_model_answer'

  constructor(model: string) {
    super(`Model ${model} returned an empty answer`)
    this.name = 'EmptyModelAnswerError'
  }
}
