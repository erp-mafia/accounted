/**
 * The three ways a click that talks to the server can fail, and the one
 * sentence the user gets for each.
 *
 * Shared by `downloadFile` (whose failure arms are structurally identical) and
 * `postAction`, so a panel that has both a "generate the file" button and a
 * "mark it paid" button describes both kinds of failure the same way.
 *
 * Exactly one sentence, never two: TOAST_LIMIT is 1
 * (components/ui/use-toast.tsx), so a second toast emitted in the same tick
 * evicts the first and only the last one is ever rendered. A handler that
 * wants to report a failure must therefore report it once, completely.
 */

export type ActionFailure =
  /** The deadline passed. Nothing was saved and nothing was reported back. */
  | { ok: false; reason: 'timeout' }
  /** The server answered non-2xx. `message` is the envelope's own message when it carries one. */
  | { ok: false; reason: 'server'; status: number; message: string }
  /** The request never completed (offline, DNS, connection reset, truncated body). */
  | { ok: false; reason: 'network'; message: string }

export interface ActionFailureCopy {
  /** Say the request took too long. "Something went wrong" is not actionable; "it timed out, try again" is. */
  timeout: string
  /** Say the browser never reached the server, so the user checks the connection instead of the data. */
  network: string
}

/**
 * Pick the single description for a failed click.
 *
 * A `server` failure keeps the server's own message: the route knows exactly
 * why it refused (bankgiro missing from company settings, the salary run is
 * not approved yet), and no copy the panel could supply comes close.
 *
 * The two client-side reasons take the caller's copy instead. `getErrorMessage`
 * has nothing better than the generic "Något gick fel" for a fetch that never
 * produced a response, and that sentence cannot tell a user whose request timed
 * out (retry, and the artefact may already have been generated server-side)
 * apart from one whose browser is offline (fix the connection first). The
 * discriminated union already separates them, so the copy should too.
 */
export function failureDescription(
  failure: ActionFailure,
  copy: ActionFailureCopy,
): string {
  switch (failure.reason) {
    case 'timeout':
      return copy.timeout
    case 'network':
      return copy.network
    case 'server':
      return failure.message
  }
}
