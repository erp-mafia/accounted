/**
 * What POST /api/support/ask sends while the support assistant answers: one
 * JSON object per line (NDJSON). Shared by the route and the support dialog,
 * so it imports nothing and runs in the browser.
 *
 * A refusal before the answer starts (not signed in, the assistant not on for
 * the company, the question limit) is an ordinary JSON error response with
 * its status, never a stream.
 */
export type SupportStreamEvent =
  /** First line: the conversation the question was stored in. Sent back as conversation_id with the next question. */
  | { type: 'start'; conversation_id: string }
  /** Answer text as it is written. */
  | { type: 'text'; delta: string }
  /**
   * The assistant is reading something (a page, the ledger). Text received
   * since the last `tools` or `start` was a remark before it, not the answer:
   * drop it.
   */
  | { type: 'tools'; names: string[] }
  /**
   * Last line of an answer: the whole answer (the text to keep, whatever was
   * streamed), and whether the assistant itself said a person should take over.
   */
  | { type: 'done'; answer: string; handoff: SupportHandoff | null }
  /** Last line of a failed answer: what happened and what to do, in the user's language. */
  | { type: 'error'; message: string; code?: string }

export interface SupportHandoff {
  reason: string
  /** The assistant's one or two sentences for the support staff. */
  summary: string
}

export function encodeSupportEvent(event: SupportStreamEvent): string {
  return `${JSON.stringify(event)}\n`
}

function isEvent(value: unknown): value is SupportStreamEvent {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'start' || type === 'text' || type === 'tools' || type === 'done' || type === 'error'
}

/**
 * Reads the events out of the response body as its chunks arrive. A chunk can
 * end in the middle of a line, so the unfinished tail is kept for the next
 * one; a line that is not an event is skipped.
 */
export function createSupportEventReader(onEvent: (event: SupportStreamEvent) => void): {
  push: (chunk: string) => void
  end: () => void
} {
  let buffer = ''
  const take = (line: string) => {
    const text = line.trim()
    if (!text) return
    try {
      const parsed: unknown = JSON.parse(text)
      if (isEvent(parsed)) onEvent(parsed)
    } catch {
      // Not a whole JSON line: nothing to show for it.
    }
  }
  return {
    push(chunk) {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        take(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    },
    end() {
      take(buffer)
      buffer = ''
    },
  }
}
