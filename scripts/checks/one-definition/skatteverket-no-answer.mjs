export default {
  rule: 'skatteverket-no-answer',
  says: 'A Skatteverket call that got no answer (its time limit ran out, or no connection) is one error from the transport, SkatteverketUnavailableError, and every door answers it with the registry entry SKATTEVERKET_UNAVAILABLE: code, status, retryable, the Swedish and English sentence and the next step.',
  home: 'src/extensions/general/skatteverket/lib/api-client.ts: SkatteverketUnavailableError, skvUnreachable, skvUnavailableAnswer',
  why: 'The same missing answer read SKATTEVERKET_UNAVAILABLE (retryable) at the agent tools and the v1 read, SKATTEVERKET_API_ERROR (not retryable) at the approval of a momsdeklaration or an AGI, and an uncoded 500 logged as our own error at the dashboard routes (#241).',
  match: [
    // The platform's no-answer errors read by hand, outside the transport.
    /message === 'fetch failed'/,
    // The answer built by hand instead of from skvUnavailableAnswer.
    /code:\s*'SKATTEVERKET_UNAVAILABLE'/,
    // Its sentence written again.
    /Skatteverket (svarade inte i tid|svarar inte just nu)/,
  ],
  sanctioned: ['extensions/general/skatteverket/lib/api-client.ts', 'lib/errors/structured-errors.ts'],
}
