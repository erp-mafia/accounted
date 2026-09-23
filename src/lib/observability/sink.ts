/**
 * Provider-agnostic observability sink.
 *
 * WHY THIS EXISTS
 * ---------------
 * This codebase has no error tracking. Everything goes to `console.*` and
 * whatever Vercel keeps in its short log retention window; nothing aggregates,
 * nothing alerts, and none of the 16 scheduled cron jobs report a failure
 * anywhere a human will see it. The observable cost is bugs that ran broken
 * for every user until a customer wrote in.
 *
 * This module is the seam. Call sites (mainly `lib/logger.ts`) talk to a small
 * stable interface; a vendor adapter is registered once at startup. Until an
 * adapter is registered the sink is a no-op, so nothing changes today and the
 * self-hosted build stays free of a third-party runtime dependency.
 *
 * WHAT A VENDOR ADAPTER MUST IMPLEMENT
 * ------------------------------------
 * Provide an object satisfying `ObservabilitySink` and register it once, from
 * a server-side init path, before any request is served:
 *
 *   registerObservabilitySink({
 *     name: 'my-vendor',
 *     captureException(error, context) { ... },
 *     captureMessage(message, level, context) { ... },
 *     async flush(timeoutMs) { return true },
 *   })
 *
 * Contract the adapter must honour:
 *
 *   - `captureException(error, context)` and `captureMessage(...)` are
 *     SYNCHRONOUS and MUST NOT THROW and MUST NOT return a promise the caller
 *     is expected to await. They are called from logging paths that run inside
 *     request handlers, cron loops and the bookkeeping engine; a slow or
 *     throwing sink would become an outage in the accounting path. Queue
 *     internally and ship in the background. (The wrappers in this file also
 *     guard with try/catch, but do not rely on that.)
 *   - `error` is NEVER a live `Error` instance. It arrives already serialized
 *     and redacted as `{ name, message, stack?, code? }` (or an arbitrary
 *     redacted value when a non-Error was thrown). Adapters that want a real
 *     stack should reconstruct it from `error.stack`.
 *   - `context` is a flat bag of ALREADY-REDACTED primitives/objects. Do not
 *     re-fetch the original values from anywhere. Reserved keys the adapter
 *     should map onto vendor concepts rather than dumping as extras:
 *       release       release / version tag (git sha, see `getRelease()`)
 *       environment   'production' | 'preview' | 'development' | custom
 *       runtime       'server' | 'client'
 *       module        logger module name, e.g. 'api/invoice.send'
 *       operation     route / cron operation name
 *       requestId     correlation id, also on the X-Request-Id response header
 *       companyId     tenant id (safe: an opaque uuid, not PII)
 *       userId        auth user id (opaque uuid)
 *       logMessage    the human-readable log line the event came from
 *       alert         true when the call site explicitly demanded paging
 *       cron          true when the event came from a scheduled job
 *     Everything else is free-form structured context; treat it as extras.
 *   - `flush(timeoutMs)` resolves `true` when the queue drained, `false` on
 *     timeout. It must never reject. Serverless functions freeze immediately
 *     after the response, so an adapter that buffers MUST implement this.
 *   - The adapter is responsible for its own sampling, rate limiting and
 *     grouping. This layer deliberately does not dedupe: suppressing the first
 *     occurrence of a failure is how outages stay invisible.
 *
 * GDPR NOTE (non-negotiable)
 * --------------------------
 * Every public entry point in this file runs `redact()` from
 * `./redact` before the sink sees anything. That is a structural guarantee,
 * not a convention: there is no code path from application data to a vendor
 * that skips the personnummer regex and the key denylist. Do not add one, and
 * do not "optimise away" the second redaction pass on records the logger has
 * already cleaned (redaction is idempotent and the cost is on the error path
 * only).
 */

import { redact, redactString } from './redact'

/** Severity as the sink sees it. Maps onto every vendor's level vocabulary. */
export type ObservabilityLevel = 'debug' | 'info' | 'warning' | 'error'

/** Flat bag of already-redacted structured fields. See the header for reserved keys. */
export type ObservabilityContext = Record<string, unknown>

export interface ObservabilitySink {
  /** Adapter name, used by `isObservabilityConfigured()` and diagnostics. */
  readonly name: string
  /** Report a failure. Synchronous, must not throw. */
  captureException(error: unknown, context: ObservabilityContext): void
  /** Report a noteworthy event without an Error object. Synchronous, must not throw. */
  captureMessage(message: string, level: ObservabilityLevel, context: ObservabilityContext): void
  /** Drain the queue. Resolves false on timeout; must never reject. */
  flush(timeoutMs?: number): Promise<boolean>
}

/**
 * Default implementation: drops everything on the floor.
 *
 * Deliberately silent rather than console-logging, because the logger has
 * already written the same record to the console by the time the sink is
 * called. Duplicating it here would double every error line.
 */
export const noopSink: ObservabilitySink = {
  name: 'noop',
  captureException() {},
  captureMessage() {},
  flush: async () => true,
}

// Module-level singleton, same pattern as `lib/events/bus.ts`.
let activeSink: ObservabilitySink = noopSink

/**
 * Register the vendor adapter. Call once, from a server-side init path, before
 * traffic is served. A second call replaces the first (last one wins), which
 * keeps dev hot-reload from stacking adapters.
 */
export function registerObservabilitySink(sink: ObservabilitySink): void {
  activeSink = sink
}

export function getObservabilitySink(): ObservabilitySink {
  return activeSink
}

/** False while the no-op default is installed, i.e. no provider is configured. */
export function isObservabilityConfigured(): boolean {
  return activeSink !== noopSink
}

/** Restore the no-op default. Intended for tests and for disabling at runtime. */
export function resetObservabilitySink(): void {
  activeSink = noopSink
}

/**
 * Release tag for every event, so a spike can be attributed to a deploy from
 * day one.
 *
 * `next.config.ts` inlines `VERCEL_GIT_COMMIT_SHA` into `NEXT_PUBLIC_BUILD_ID`
 * at build time (it powers the DeployReloadPrompt and /api/version), which
 * makes it the one release identifier that is already present in BOTH the
 * server and the client bundle. Reading the same value here means the sink,
 * the reload prompt and /api/version all agree on what "this deploy" is.
 * `process.env.NEXT_PUBLIC_BUILD_ID` must stay written out literally: Next
 * does a textual substitution on it, so a computed lookup would not be
 * replaced. `VERCEL_GIT_COMMIT_SHA` is the runtime fallback for server-only
 * contexts that were not built by Next (scripts, standalone workers).
 *
 * Returns null on dev and self-hosted builds, where there is no release to tag.
 */
export function getRelease(): string | null {
  const override = process.env.OBSERVABILITY_RELEASE
  if (override) return override
  const buildId = process.env.NEXT_PUBLIC_BUILD_ID
  if (buildId) return buildId
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  return sha ? sha : null
}

/** production | preview | development, or an explicit override. */
export function getEnvironment(): string {
  return (
    process.env.OBSERVABILITY_ENVIRONMENT ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    'development'
  )
}

/**
 * Redact caller-supplied context, then stamp the reserved fields.
 *
 * The reserved fields are applied AFTER the spread so a caller cannot
 * accidentally (or maliciously) override the release/environment tagging with
 * a context key of the same name.
 */
function enrich(context: ObservabilityContext | undefined): ObservabilityContext {
  const safe = (redact(context ?? {}) as ObservabilityContext) ?? {}
  return {
    ...safe,
    release: getRelease(),
    environment: getEnvironment(),
    runtime: typeof window === 'undefined' ? 'server' : 'client',
  }
}

/**
 * Report a failure to the configured provider.
 *
 * Redacts both the error and the context first. Never throws: a broken sink
 * must not take down the code path that was merely trying to report a problem.
 */
export function captureException(error: unknown, context: ObservabilityContext = {}): void {
  try {
    activeSink.captureException(redact(error), enrich(context))
  } catch {
    // A failing provider must never surface as an application error.
  }
}

/**
 * Report a noteworthy event that has no Error object attached.
 *
 * Redacts the message and the context first. Never throws.
 */
export function captureMessage(
  message: string,
  level: ObservabilityLevel = 'error',
  context: ObservabilityContext = {},
): void {
  try {
    activeSink.captureMessage(redactString(message), level, enrich(context))
  } catch {
    // A failing provider must never surface as an application error.
  }
}

/**
 * Drain the provider's queue.
 *
 * Serverless functions freeze the moment the response is returned, so any
 * long-running path that must not lose its last events (cron handlers, queue
 * workers) should await this before returning. Resolves false if the provider
 * timed out or threw; never rejects.
 */
export async function flushObservability(timeoutMs = 2000): Promise<boolean> {
  try {
    return await activeSink.flush(timeoutMs)
  } catch {
    return false
  }
}
