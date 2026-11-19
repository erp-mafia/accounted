/**
 * The platform's two errors for "Skatteverket did not answer", built the way
 * the runtime builds them: the transport's time limit (AbortSignal.timeout)
 * and a refused connection (undici's "fetch failed" with ECONNREFUSED as its
 * cause). A door's test passes each through asSkvUnavailable, the transport's
 * own conversion, and reads the one answer (skvUnavailableAnswer).
 */
export const NO_ANSWER: ReadonlyArray<[string, () => Error]> = [
  ['the time limit ran out', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  [
    'the connection was refused',
    () =>
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      }),
  ],
]
