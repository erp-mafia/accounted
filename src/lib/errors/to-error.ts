import { describeThrown } from '@/lib/observability/redact'

/** An Error built from a thrown value: `code` set when the value had one. */
export type ThrownError = Error & { code?: string }

/**
 * Any thrown value as an Error that says what failed, for a log line.
 *
 * Supabase hands back a failed query's error as a plain object
 * ({ message, code, details, hint }), and `if (error) throw error` is how most
 * code passes it on. `new Error(String(value))` made every such value
 * "Error: [object Object]": the log line and the error tracker both lost the
 * message and the SQLSTATE, and unrelated failures merged into one issue.
 *
 * An Error is returned as it is. A plain object keeps its own message
 * (PostgREST, GoTrue, OAuth and nested { error: { message } } shapes), its
 * name (PostgrestError, AuthError) and its code; a string becomes the message.
 * PostgREST `details` is left out: it echoes row values ("Failing row
 * contains (...)"). The stack starts at the caller, so the event still groups
 * on the code that logged it. Redaction stays with the logger and the sink.
 */
export function toError(value: unknown): ThrownError {
  if (value instanceof Error) return value
  const { name, message, code } = describeThrown(value)
  const error: ThrownError = new Error(message)
  error.name = name
  if (typeof code === 'string' || typeof code === 'number') error.code = String(code)
  // Re-capture with the name set, so the stack header reads
  // "PostgrestError: <message>" and toError's own frame is not the top one.
  if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(error, toError)
  return error
}
