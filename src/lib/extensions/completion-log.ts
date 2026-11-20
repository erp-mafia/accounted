/**
 * What a skipAuth extension handler tells the dispatcher about its own
 * request, for the one "extension call completed" line the dispatcher
 * (app/api/extensions/ext/[...path]/route.ts) writes per call.
 *
 * The dispatcher sees only the HTTP status and the wall time; the handler
 * knows what the call was (for the MCP endpoint: the JSON-RPC method, the
 * tool, the key and company). Keyed by the Request object the dispatcher
 * handed the handler, so no return path has to thread anything back.
 *
 * Only identifiers and protocol vocabulary go here: never tool arguments,
 * results or anything else a customer typed.
 */

export type CompletionLogValue = string | number | boolean | null

export interface CompletionLogNote {
  /** Extra fields on the completion line (ids and protocol names only). */
  fields?: Record<string, CompletionLogValue>
  /**
   * The call is protocol chatter (a handshake, a notification, a probe the
   * spec answers with a fixed status) that something else already records:
   * the dispatcher writes no line for it unless it failed with a 5xx.
   */
  quiet?: boolean
}

const notes = new WeakMap<Request, CompletionLogNote>()

/** Merge `note` into what is already noted for `request`. */
export function noteCompletionLog(request: Request, note: CompletionLogNote): void {
  const current = notes.get(request)
  notes.set(request, {
    fields: { ...current?.fields, ...note.fields },
    quiet: note.quiet ?? current?.quiet,
  })
}

/** What the handler noted for `request`, if anything. */
export function readCompletionLog(request: Request): CompletionLogNote | undefined {
  return notes.get(request)
}

/** Whether the dispatcher writes its completion line for this call. */
export function shouldWriteCompletionLog(note: CompletionLogNote | undefined, status: number): boolean {
  return !note?.quiet || status >= 500
}
