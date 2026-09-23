# Logging and Observability Pipeline

This document states what the logging pipeline actually is in production, and
the non-negotiable redaction contract for anything that forwards log data to a
third party.

## The pipeline today

- `src/lib/logger.ts` writes structured log records to stdout/stderr. On hosted
  (Vercel) these are collected by the platform and delivered through the
  configured Vercel log drain, which is the production log delivery path.
- `src/lib/observability/sink.ts` is a provider-agnostic seam for an error
  tracking vendor. It is a deliberate no-op until an adapter is registered
  with `registerObservabilitySink()` from a server-side init path. No adapter
  is registered by default, so self-hosted builds carry no third-party
  runtime dependency and setting the DSN environment variables alone changes
  nothing.

That means: until a vendor adapter is wired, error-level events reach a human
only through the log drain. Any production deployment that wants alerting
must either configure the log drain with alert rules or register a sink
adapter; a no-op sink is not an alerting pipeline on its own.

## Redaction contract (GDPR, non-negotiable)

`src/lib/observability/redact.ts` is the single source of truth for what must
never leave the process in clear text: a key denylist (passwords, tokens,
IBAN, personnummer, ...), a personnummer regex applied to every string, and
substring patterns for emails, Swedish IBANs, and gnubok API keys.

Structural guarantees, verified in the code:

- Every public entry point of the sink module (`captureException`,
  `captureMessage`) runs `redact()` / `redactString()` on the error, the
  message, and the context BEFORE the registered adapter sees anything. There
  is no code path from application data to a vendor that skips redaction.
- Adapters receive errors already serialized and redacted as plain objects,
  never live `Error` instances, and must not re-fetch original values.
- `redact()` is idempotent, so double-redaction on records the logger already
  cleaned is safe and is intentionally not "optimised away".

Rules for anyone adding an adapter or a new emission path:

1. Never call a vendor SDK directly from application code. Route through
   `captureException` / `captureMessage` so redaction stays structural.
2. A browser-side adapter (one reading `NEXT_PUBLIC_OBSERVABILITY_DSN`) ships
   data straight from the user's browser to the vendor and bypasses every
   server-side control. It MUST apply the same redaction module before
   emitting: import from `src/lib/observability/redact.ts` and run all payloads
   through `redact()` / `redactString()` client-side. Do not register a
   browser adapter that forwards raw console or log payloads.
3. Do not add a log emission path (new logger, direct `console.*` forwarding,
   CI log shipping) that reaches a third party without going through the
   redact module first.

The redaction behavior is pinned by unit tests under
`src/lib/observability/__tests__/`; extend them when the denylist or patterns
change.
