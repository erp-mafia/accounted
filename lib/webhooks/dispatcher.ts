/**
 * Webhook delivery dispatcher.
 *
 * Invoked from the per-minute cron at /api/webhooks/dispatch/cron. Picks up
 * pending + retry-due deliveries (FOR UPDATE SKIP LOCKED so multiple cron
 * invocations don't double-deliver), POSTs each one with HMAC signature,
 * and updates the row to one of:
 *
 *   - delivered (2xx response)         : terminal
 *   - failed   (5xx / network / 4xx    : non-terminal until attempts
 *               other than 410)         exhausted; bumps next_attempt_at
 *               by exponential backoff
 *   - dead     (HTTP 410 OR             : terminal
 *               attempts exhausted)
 *
 * The receiver is expected to respond within 10 seconds; we time out
 * aggressively so a slow receiver doesn't block the per-minute cron.
 *
 * On HTTP 410 we additionally disable the webhook (sets disabled_at +
 * disabled_reason='HTTP 410 from receiver') so future events don't even
 * enqueue against it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { signPayload } from './signing'
import { pinnedHttpsFetch, type PinnedFetchResult } from './pinned-fetch'
import { createLogger } from '@/lib/logger'

const log = createLogger('webhooks/dispatcher')

/** 7 retries over ~87h (≈3.6 days). Index = attempts BEFORE this one. */
const RETRY_BACKOFF_SECONDS: ReadonlyArray<number> = [
  60,        //  1m: first retry
  5 * 60,    //  5m
  30 * 60,   // 30m
  2 * 60 * 60,   //  2h
  12 * 60 * 60,  // 12h
  24 * 60 * 60,  // 24h
  48 * 60 * 60,  // 48h: final retry
]

const MAX_ATTEMPTS = RETRY_BACKOFF_SECONDS.length + 1 // initial + 7 retries = 8 total
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BODY_BYTES = 4096

interface DueDelivery {
  id: string
  webhook_id: string
  company_id: string
  event_type: string
  payload: Record<string, unknown>
  previous_attributes: Record<string, unknown> | null
  api_version: string
  attempts: number
}

interface WebhookForDelivery {
  id: string
  company_id: string
  webhook_url: string
  secret: string
}

export interface DispatchSummary {
  picked: number
  delivered: number
  failed: number
  dead: number
}

/**
 * Run one dispatch cycle. Picks up to `batchSize` due deliveries and
 * processes them sequentially (the per-minute cadence + small batch size
 * makes parallelism unnecessary; in-process serial is also gentler on the
 * receiver if many events fan out to the same URL).
 */
export async function dispatchDueDeliveries(args: {
  supabase: SupabaseClient
  /** Max rows to claim per cron tick. Default 50. */
  batchSize?: number
  /** Override for tests. */
  now?: Date
  /** Override for tests; injected pinned-fetch implementation. */
  pinnedFetchImpl?: typeof pinnedHttpsFetch
}): Promise<DispatchSummary> {
  const batchSize = args.batchSize ?? 50
  const now = args.now ?? new Date()
  const pinnedFetchImpl = args.pinnedFetchImpl ?? pinnedHttpsFetch

  const summary: DispatchSummary = { picked: 0, delivered: 0, failed: 0, dead: 0 }

  // Recover stuck in_flight rows: a previous tick that was killed mid-flight
  // (Vercel function timeout, hard crash, manual termination) leaves rows
  // marked in_flight forever otherwise. Sweep them back to 'failed' so the
  // retry loop picks them up at next_attempt_at.
  //
  // Threshold = 2× REQUEST_TIMEOUT_MS. A live attempt takes at most
  // REQUEST_TIMEOUT_MS plus the body read; doubling that gives an
  // unambiguous "this is stuck, not in-flight" boundary.
  await recoverStuckInFlight(args.supabase, now)

  const due = await claimDueDeliveries(args.supabase, batchSize, now)
  summary.picked = due.length
  if (due.length === 0) return summary

  // Dedupe webhook lookups within a single cycle.
  const webhookIds = Array.from(new Set(due.map((d) => d.webhook_id)))
  const webhookMap = await loadWebhooksByIds(args.supabase, webhookIds)

  for (const delivery of due) {
    const webhook = webhookMap.get(delivery.webhook_id)
    if (!webhook) {
      // The webhook was deleted between enqueue and dispatch. Mark dead;
      // there's no receiver to deliver to. The webhook_deliveries.webhook_id
      // FK is ON DELETE SET NULL (migration 20260515170000), so the row
      // stays in the audit trail under status='dead'.
      await markDead(args.supabase, delivery.id, 'webhook_deleted')
      summary.dead++
      continue
    }

    // Defense-in-depth tenancy check: the webhook the delivery row points
    // at MUST belong to the same company as the delivery row. Mismatch
    // indicates a poisoned row: refuse to dispatch (which would sign with
    // the wrong tenant's secret and POST to the wrong receiver).
    if (webhook.company_id !== delivery.company_id) {
      log.error('cross-tenant delivery refused', new Error('company_id mismatch'), {
        deliveryId: delivery.id,
        deliveryCompanyId: delivery.company_id,
        webhookId: webhook.id,
        webhookCompanyId: webhook.company_id,
      })
      await markDead(args.supabase, delivery.id, 'cross_tenant_mismatch')
      summary.dead++
      continue
    }

    const outcome = await attemptDelivery({
      delivery,
      webhook,
      pinnedFetchImpl,
      now,
    })

    // Structured per-delivery outcome log. Keeps companyId / webhookId /
    // deliveryId available in log aggregation for per-tenant audit-trail
    // reconstruction without grepping through individual mark*-helper
    // writes (V16, security event correlation).
    const logCtx = {
      deliveryId: delivery.id,
      webhookId: webhook.id,
      companyId: delivery.company_id,
      eventType: delivery.event_type,
      attempt: delivery.attempts + 1,
    }

    switch (outcome.kind) {
      case 'delivered':
        await markDelivered(args.supabase, delivery.id, outcome)
        log.info('delivery succeeded', { ...logCtx, responseStatus: outcome.responseStatus })
        summary.delivered++
        break
      case 'dead':
        await markDead(args.supabase, delivery.id, outcome.reason, outcome)
        log.warn('delivery dead', { ...logCtx, reason: outcome.reason, responseStatus: outcome.responseStatus })
        summary.dead++
        if (outcome.disableWebhook) {
          await disableWebhook(args.supabase, webhook.id, outcome.reason)
          log.warn('webhook auto-disabled', { ...logCtx, reason: outcome.reason })
        }
        break
      case 'failed':
        if (delivery.attempts + 1 >= MAX_ATTEMPTS) {
          await markDead(args.supabase, delivery.id, 'attempts_exhausted', outcome)
          log.warn('delivery dead: attempts exhausted', { ...logCtx, lastError: outcome.error })
          summary.dead++
        } else {
          await markFailedForRetry(args.supabase, delivery.id, delivery.attempts, outcome, now)
          log.info('delivery failed: retry scheduled', { ...logCtx, error: outcome.error, responseStatus: outcome.responseStatus })
          summary.failed++
        }
        break
    }
  }

  return summary
}

// ──────────────────────────────────────────────────────────────────────
// DB ops
// ──────────────────────────────────────────────────────────────────────

/**
 * Mark in_flight rows whose updated_at is older than the stuck-threshold
 * back to 'failed' with next_attempt_at = now so they re-enter the
 * dispatch queue. Best-effort: a write failure here is logged but
 * doesn't block the rest of the cycle.
 */
async function recoverStuckInFlight(supabase: SupabaseClient, now: Date): Promise<void> {
  const stuckBefore = new Date(now.getTime() - 2 * REQUEST_TIMEOUT_MS)
  // Under READ COMMITTED (Postgres default), UPDATE re-evaluates the WHERE
  // clause against each row's current value when it acquires the row lock.
  // A row that raced from 'in_flight' to 'delivered'/'dead' between scan
  // and lock will fail status='in_flight' on re-evaluation and be skipped
  // entirely: the immutability trigger never fires, so a mid-flight
  // terminal flip cannot abort the bulk update.
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .update({
      status: 'failed',
      next_attempt_at: now.toISOString(),
      error: 'recovered_from_in_flight_timeout',
    })
    .eq('status', 'in_flight')
    .lt('updated_at', stuckBefore.toISOString())
    .select('id')

  if (error) {
    log.warn('stuck in_flight recovery failed', { code: error.code })
    return
  }
  if (data && data.length > 0) {
    log.warn('recovered stuck in_flight rows', { count: data.length })
  }
}

async function claimDueDeliveries(
  supabase: SupabaseClient,
  batchSize: number,
  now: Date,
): Promise<DueDelivery[]> {
  // Atomic FOR UPDATE SKIP LOCKED claim via the SQL function shipped in
  // migration 20260515220000. PostgREST can't express SKIP LOCKED through
  // the JS client, so the function form is the documented entry point:
  // see the migration comment for the full rationale (one round trip,
  // no CAS contention, rows locked by a concurrent tick are simply
  // invisible to the second caller).
  //
  // All filter semantics from the previous JS path are preserved inside
  // the function: status IN ('pending','failed'), next_attempt_at <= now,
  // webhook_id IS NOT NULL, ORDER BY next_attempt_at ASC, LIMIT batchSize.
  const { data, error } = await supabase.rpc('claim_due_webhook_deliveries', {
    p_batch_size: batchSize,
    p_now: now.toISOString(),
  })

  if (error) {
    log.error('claim_due_webhook_deliveries rpc failed', error as Error)
    return []
  }
  return (data ?? []) as DueDelivery[]
}

async function loadWebhooksByIds(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, WebhookForDelivery>> {
  // Include company_id so the dispatch loop can assert that the delivery
  // row's company_id matches the webhook's: defense in depth against a
  // poisoned delivery row pointing at another tenant's webhook
  // (compromised service-role path, faulty INSERT in a future code path,
  // etc.). The DB trigger added in 20260515190000 enforces the same
  // invariant at INSERT time; this is the application-layer mirror.
  const { data, error } = await supabase
    .from('webhooks')
    .select('id, company_id, webhook_url, secret')
    .in('id', ids)

  if (error || !data) {
    log.error('webhook lookup for dispatch failed', error as Error)
    return new Map()
  }
  return new Map((data as WebhookForDelivery[]).map((w) => [w.id, w]))
}

async function markDelivered(
  supabase: SupabaseClient,
  id: string,
  outcome: DeliveredOutcome,
): Promise<void> {
  const { error } = await supabase
    .from('webhook_deliveries')
    .update({
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      attempts: outcome.attempts,
      response_status: outcome.responseStatus,
      response_body: outcome.responseBody,
      response_headers: outcome.responseHeaders,
      error: null,
    })
    .eq('id', id)
  if (error) log.warn('mark delivered update failed', { id, code: error.code })
}

async function markFailedForRetry(
  supabase: SupabaseClient,
  id: string,
  priorAttempts: number,
  outcome: FailedOutcome,
  now: Date,
): Promise<void> {
  const nextAttemptIndex = priorAttempts // 0-indexed lookup into RETRY_BACKOFF_SECONDS
  const backoffSeconds = RETRY_BACKOFF_SECONDS[Math.min(nextAttemptIndex, RETRY_BACKOFF_SECONDS.length - 1)]
  const nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000)

  const { error } = await supabase
    .from('webhook_deliveries')
    .update({
      status: 'failed',
      attempts: priorAttempts + 1,
      next_attempt_at: nextAttemptAt.toISOString(),
      response_status: outcome.responseStatus ?? null,
      response_body: outcome.responseBody ?? null,
      response_headers: outcome.responseHeaders ?? null,
      error: outcome.error,
    })
    .eq('id', id)
  if (error) log.warn('mark failed-for-retry update failed', { id, code: error.code })
}

async function markDead(
  supabase: SupabaseClient,
  id: string,
  reason: string,
  outcome?: AttemptOutcome,
): Promise<void> {
  // delivered_at means "the receiver acknowledged the event". For dead
  // rows (HTTP 410, attempts exhausted, webhook deleted, cross-tenant
  // mismatch, unsafe URL) the receiver did NOT acknowledge: leaving
  // delivered_at NULL keeps the audit semantics clean. An auditor
  // querying `WHERE delivered_at IS NOT NULL` correctly sees only
  // genuinely delivered rows. The terminal-state timestamp lives on
  // `updated_at` (auto-stamped by the table's BEFORE UPDATE trigger).
  const { error } = await supabase
    .from('webhook_deliveries')
    .update({
      status: 'dead',
      attempts: outcome && 'attempts' in outcome ? outcome.attempts : undefined,
      response_status: outcome && 'responseStatus' in outcome ? outcome.responseStatus : null,
      response_body: outcome && 'responseBody' in outcome ? outcome.responseBody : null,
      response_headers: outcome && 'responseHeaders' in outcome ? outcome.responseHeaders : null,
      error: reason,
    })
    .eq('id', id)
  if (error) log.warn('mark dead update failed', { id, code: error.code })
}

async function disableWebhook(
  supabase: SupabaseClient,
  webhookId: string,
  reason: string,
): Promise<void> {
  // Snapshot before the disable so the audit entry can record the prior
  // state. Service-role read; bypasses RLS.
  const { data: prior } = await supabase
    .from('webhooks')
    .select('user_id, company_id, name, active, disabled_at, disabled_reason')
    .eq('id', webhookId)
    .maybeSingle()

  const { error } = await supabase
    .from('webhooks')
    .update({
      disabled_at: new Date().toISOString(),
      disabled_reason: reason,
      active: false,
    })
    .eq('id', webhookId)
  if (error) {
    log.warn('webhook auto-disable failed', { webhookId, code: error.code })
    return
  }

  // V16 security event log. Auto-disable is a privileged action taken by
  // the dispatcher (not a human caller), so actor_id is null. The
  // audit_log entry is written UNCONDITIONALLY (even when prior is null
  // or prior.user_id is null) because the SECURITY_EVENT must produce
  // a durable record (A.8.15 / V16.1.1 / CC7.2). The audit_log.user_id
  // column is nullable post-multi-tenant-refactor (20260330130000), so
  // a system-initiated event can legitimately write user_id=NULL. Such
  // rows are invisible under the user-scoped SELECT policy but remain
  // queryable under service-role review, which is appropriate for
  // system-initiated events.
  //
  // The reason discriminates between the three auto-disable paths
  // (http_410_gone / redirect_blocked / url_unsafe:<class>) so SIEM
  // tooling can alert on systematic patterns.
  const p = prior as {
    user_id: string | null
    company_id: string | null
    name: string
    active: boolean
    disabled_at: string | null
    disabled_reason: string | null
  } | null

  const { error: auditErr } = await supabase.from('audit_log').insert({
    user_id: p?.user_id ?? null,
    company_id: p?.company_id ?? null,
    action: 'SECURITY_EVENT',
    table_name: 'webhooks',
    record_id: webhookId,
    actor_id: null,
    description: p
      ? `Webhook auto-disabled by dispatcher: ${reason} (was "${p.name}")`
      : `Webhook auto-disabled by dispatcher: ${reason} (prior snapshot unavailable)`,
    old_state: p
      ? { active: p.active, disabled_at: p.disabled_at, disabled_reason: p.disabled_reason }
      : null,
    new_state: { active: false, disabled_reason: reason, disabled_at: new Date().toISOString() },
  })
  if (auditErr) {
    log.warn('audit_log insert failed for webhook auto-disable', {
      webhookId,
      reason,
      code: auditErr.code,
    })
  }
}

// ──────────────────────────────────────────────────────────────────────
// HTTP attempt
// ──────────────────────────────────────────────────────────────────────

type DeliveredOutcome = {
  kind: 'delivered'
  attempts: number
  responseStatus: number
  responseBody: string | null
  responseHeaders: Record<string, string> | null
}

type FailedOutcome = {
  kind: 'failed'
  attempts: number
  responseStatus: number | null
  responseBody: string | null
  responseHeaders: Record<string, string> | null
  error: string
}

type DeadOutcome = {
  kind: 'dead'
  reason: string
  disableWebhook: boolean
  attempts: number
  responseStatus: number | null
  responseBody: string | null
  responseHeaders: Record<string, string> | null
  error?: string
}

type AttemptOutcome = DeliveredOutcome | FailedOutcome | DeadOutcome

async function attemptDelivery(args: {
  delivery: DueDelivery
  webhook: WebhookForDelivery
  pinnedFetchImpl: typeof pinnedHttpsFetch
  now: Date
}): Promise<AttemptOutcome> {
  const { delivery, webhook, pinnedFetchImpl, now } = args
  const attempts = delivery.attempts + 1
  const requestId = `whdel_${delivery.id}`

  const body = JSON.stringify({
    id: delivery.id,
    type: delivery.event_type,
    api_version: delivery.api_version,
    created: Math.floor(now.getTime() / 1000),
    data: { object: delivery.payload },
    previous_attributes: delivery.previous_attributes,
  })

  const { header } = signPayload({
    body,
    secret: webhook.secret,
    timestamp: Math.floor(now.getTime() / 1000),
  })

  // pinnedHttpsFetch performs DNS validation AND opens the socket against
  // the validated IP in a single call. The previous shape (separate
  // validateWebhookUrl + fetch calls) left a DNS-rebinding window between
  // the two, closed here. SNI + Host header continue to carry the
  // original hostname so receiver-side TLS + vhost routing still work.
  const result = await pinnedFetchImpl(webhook.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gnubok-Signature': header,
      'X-Gnubok-Event': delivery.event_type,
      'X-Gnubok-Delivery': delivery.id,
      'X-Gnubok-Api-Version': delivery.api_version,
      'X-Request-Id': requestId,
      'User-Agent': 'gnubok-webhook/1',
    },
    body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BODY_BYTES,
  })

  switch (result.kind) {
    case 'unsafe_url':
      return {
        kind: 'dead',
        reason: `url_unsafe:${result.reason}`,
        disableWebhook: true,
        attempts,
        responseStatus: null,
        responseBody: null,
        responseHeaders: null,
        error: result.detail,
      }
    case 'redirect_blocked':
      return {
        kind: 'dead',
        reason: 'redirect_blocked',
        disableWebhook: true,
        attempts,
        responseStatus: result.status,
        responseBody: null,
        responseHeaders: null,
        error: truncateError(result.detail),
      }
    case 'timeout':
    case 'transport_error':
      return {
        kind: 'failed',
        attempts,
        responseStatus: null,
        responseBody: null,
        responseHeaders: null,
        error: truncateError(result.detail),
      }
    case 'ok': {
      const responseHeaders = filterResponseHeaders(result.headers)
      const responseBody = isSafeContentType(result.headers['content-type'] ?? '')
        ? result.body
        : null

      // HTTP 410: receiver explicitly asks us to stop. Auto-disable.
      if (result.status === 410) {
        return {
          kind: 'dead',
          reason: 'http_410_gone',
          disableWebhook: true,
          attempts,
          responseStatus: 410,
          responseBody,
          responseHeaders,
        }
      }

      if (result.status >= 200 && result.status < 300) {
        return {
          kind: 'delivered',
          attempts,
          responseStatus: result.status,
          responseBody,
          responseHeaders,
        }
      }

      return {
        kind: 'failed',
        attempts,
        responseStatus: result.status,
        responseBody,
        responseHeaders,
        error: `HTTP ${result.status}`,
      }
    }
  }
}

function truncateError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 497)}...` : message
}

// Content-Type prefixes for which we persist response_body verbatim. Other
// types (text/html error pages, application/octet-stream, ...) get dropped
// because they routinely echo PII back from receiver-side error renderers
// (Art.32(1)(b), A.8.12). A null body is just as useful for debugging
// when the operator can see the response_status and response_headers.
const SAFE_BODY_CONTENT_TYPE_PREFIXES = ['text/plain', 'application/json']

function isSafeContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase()
  return SAFE_BODY_CONTENT_TYPE_PREFIXES.some((p) => lower.startsWith(p))
}

// Allowlist for response_headers persistence. Receiver-side headers like
// Set-Cookie, Authorization, WWW-Authenticate, internal tracing, and
// vendor x-* headers can carry credentials or sensitive identifiers; we
// don't need them for delivery diagnostics. (CC7.2 / Art.32(1)(b))
//
// 'server' is deliberately NOT in the allowlist (A.8.12): it carries no
// diagnostic value but routinely leaks receiver infrastructure version
// strings (nginx/1.21.6, Apache/2.4.41, ...) into a multi-tenant audit
// table.
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'date',
  'x-request-id',
  'cf-ray',
])

function filterResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SAFE_RESPONSE_HEADERS.has(k.toLowerCase())) {
      obj[k] = v
    }
  }
  return obj
}

export const __TESTING__ = {
  RETRY_BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
}
