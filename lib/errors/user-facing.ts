/**
 * Errors whose own message is already written for the user.
 *
 * The structured-error registry answers a code with a canned sentence, which is
 * right for the codes it knows: a Postgres 23505 has no useful English of its
 * own, and INTERNAL_ERROR must never echo whatever a library threw. But a
 * handful of domain errors are the opposite case. They are raised with a
 * complete Swedish sentence naming the account, the fiscal year or the setting
 * the user has to change, and replacing that with the registry's generic line
 * throws away the only part that could have helped.
 *
 * Two observed on one migration afternoon (2026-09-15), both in the SIE import:
 *
 *   "Nya SIE-importer är tillfälligt pausade. Pågående importer fortsätter."
 *     reached the wizard as "Förfrågan innehåller ogiltiga uppgifter", which
 *     sent its reader looking for a fault in their own file.
 *
 *   "Räkenskapsåret 2021 ... är markerat som avslutat i ett tidigare program
 *     ... Öppna det igen under Inställningar > Bokföring > Räkenskapsår"
 *     reached it as "Ett oväntat serverfel uppstod. Försök igen senare." An
 *     expected, self-serve state, reported as a 500.
 *
 * Opt-in on purpose. Letting every Error speak would leak developer English and
 * library internals into the product the first time something unexpected threw;
 * the marker is how an author says "I wrote this one for the reader".
 *
 * Swedish in both locales, like the bookkeeping engine's other domain errors:
 * `.claude/rules/i18n.md` keeps regulatory wording untranslated because the
 * English equivalents are ambiguous ("verifikat", "klarmarkerad", "räkenskapsår").
 */

/** Non-enumerable so the flag never rides along into a details payload. */
const USER_FACING = Symbol.for('accounted.userFacingMessage')

/**
 * Mark an error's message as ready to show. Returns the same error so it can
 * be thrown in one expression: `throw userFacing(new Error(refusal))`.
 *
 * `code` decides the HTTP status and the envelope's code, so the caller still
 * picks how the failure is classified; only the sentence comes from the error.
 */
export function userFacing<E extends Error>(error: E, code = 'VALIDATION_ERROR'): E {
  Object.defineProperty(error, USER_FACING, {
    value: code,
    enumerable: false,
    configurable: true,
  })
  return error
}

/**
 * The structured code a user-facing error carries, or null when it is not one.
 * A blank message does not count: an empty sentence is worse than the registry's.
 */
export function userFacingCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  const code = (err as unknown as Record<symbol, unknown>)[USER_FACING]
  if (typeof code !== 'string') return null
  return err.message.trim() === '' ? null : code
}
