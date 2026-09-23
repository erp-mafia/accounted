/**
 * Observability: the one place errors leave this process for a human to see.
 *
 * Import from `@/lib/observability`. The interface a vendor adapter has to
 * satisfy, and the guarantees it has to honour, are documented in full in
 * `./sink.ts`. The short version:
 *
 *   1. Write an adapter object satisfying `ObservabilitySink`.
 *   2. Register it once from a server-side init path:
 *        registerObservabilitySink(myAdapter)
 *   3. Nothing else changes. Call sites already route through the interface,
 *      and until step 2 happens the sink is a no-op, so core and self-hosted
 *      builds run with zero third-party runtime code.
 *
 * Almost nothing should call `captureException` / `captureMessage` directly:
 * log through `createLogger()` (`@/lib/logger`) instead. The logger forwards
 * every `error` record, plus anything flagged `alert: true`, to the sink with
 * the request context already bound, so the event arrives correlated with the
 * log line rather than orphaned. Direct calls are for code that has no logger
 * in scope.
 *
 * Env vars (all optional, see `.env.example`): `OBSERVABILITY_DSN`,
 * `NEXT_PUBLIC_OBSERVABILITY_DSN`, `OBSERVABILITY_ENVIRONMENT`,
 * `OBSERVABILITY_RELEASE`. They are read by the adapter, not by this module:
 * setting them without registering an adapter changes nothing.
 */

export {
  captureException,
  captureMessage,
  registerObservabilitySink,
  type ObservabilityContext,
  type ObservabilityLevel,
  type ObservabilitySink,
} from './sink'
