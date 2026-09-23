/**
 * Is this error a client hanging up mid-response, rather than a failure?
 *
 * When a browser navigates away while a page or RSC payload is still
 * streaming, the HTTP response closes, Next destroys the stream it handed
 * React (`node_modules/next/dist/server/pipe-readable.js`), and React's
 * `createCancelHandler` aborts the in-flight render with a bare
 * `Error('The destination stream closed early.')`. Both renderers do it: the
 * Flight server (react-server-dom-webpack-server.node.production.js:3922) and
 * react-dom's SSR streamer (react-dom-server.node.production.js:7822, :8099).
 * The response itself still completes: every occurrence we sampled in
 * production rode on a 200.
 *
 * Next means to swallow these. `create-error-handler.js` early-returns on
 * `isAbortError`, but that predicate knows only `name === 'AbortError'` and
 * `name === 'ResponseAborted'` (pipe-readable.js:32), and React's cancel error
 * is a plain `Error`, so it falls through to `onRequestError` and is reported
 * as an exception that never happened. This predicate closes that gap on our
 * side. It is a Next filtering gap, not a version bug: 16.3.1 and 16.3.4 are
 * byte-identical here, so upgrading is not the fix.
 *
 * Matching is on the EXACT message. A React rewording brings the noise back,
 * which is the safe direction; a substring match would let a real error hide
 * behind the phrase.
 *
 * Deliberately NOT matched: a bare `AbortError`, `ECONNRESET`,
 * `ERR_STREAM_PREMATURE_CLOSE`. Those are how this codebase's outbound calls
 * report genuine failures (`AbortSignal.timeout` in `lib/http/fetch-with-timeout`
 * and every provider client; `lib/providers/with-provider-call` treats them as
 * retryable provider faults), and swallowing them would hide real integration
 * breakage. They also buy nothing here: Next already filters `AbortError`
 * before instrumentation ever sees it.
 */

const CLIENT_DISCONNECT_MESSAGES = new Set([
  'The destination stream closed early.',
  'The destination stream errored while writing data.',
])

/**
 * Next's own error for a response the client aborted
 * (`server/web/spec-extension/adapters/next-request.js:39`). Unlike a plain
 * `AbortError`, this name is only ever produced by that one situation.
 */
const RESPONSE_ABORTED_NAME = 'ResponseAborted'

export function isClientDisconnectError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  if (name === RESPONSE_ABORTED_NAME) return true
  return typeof message === 'string' && CLIENT_DISCONNECT_MESSAGES.has(message)
}
