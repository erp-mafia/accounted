/**
 * Webhook delivery dispatcher.
 *
 * Invoked from two places: the per-minute cron at /api/webhooks/dispatch/cron,
 * and an emit-triggered kick right after deliveries are enqueued
 * (lib/webhooks/dispatch-kick.ts), which is what keeps first-attempt latency
 * off the cron interval. Picks up pending + retry-due deliveries (FOR UPDATE
 * SKIP LOCKED, so a kick racing the cron claims disjoint rows), POSTs each one
 * with HMAC signature, and updates the row to one of:
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

/** Rows claimed per cycle when the caller passes nothing: the cron. */
const DEFAULT_BATCH_SIZE = 50

/**
 * Wall-clock ceiling on one cycle's serial attempt loop. 50 rows at a 10 s
 * receiver timeout is 500 s of worst case, which no serverless invocation
 * survives, so bound the cycle explicitly instead of letting the platform
 * kill it mid-loop and leaving the remainder to the sweep.
 *
 * The cron route backs this with `export const maxDuration = 300`
 * (app/api/webhooks/dispatch/cron/route.ts): the budget is only a real bound
 * if the platform actually grants the invocation more wall time than the
 * budget spends, and the release path below only runs if the loop is still
 * alive when the budget expires.
 */
const CYCLE_BUDGET_MS = 120_000

/** Slack over the cycle bound: claim round trip, re-stamp, terminal write, clock skew. */
const STUCK_RECOVERY_SLACK_MS = 30_000

/**
 * How long an in_flight row may legitimately sit before the sweep may treat
 * it as abandoned: 160 s. Derived, not guessed (#1257), and deliberately
 * independent of batch size.
 *
 * A cycle attempts its rows serially at up to REQUEST_TIMEOUT_MS each, but
 * the loop is cut off by CYCLE_BUDGET_MS regardless of how many rows were
 * claimed, so the BUDGET, not the row count, is what bounds a cycle's life:
 * budget + one in-flight request + slack. A 5-row kick and a 50-row cron
 * therefore use the same window, which is what the tenant-global sweep needs
 * (neither caller may re-arm a row the other still owns). Anything
 * batch-derived would let the kick pick a window narrower than the cron's
 * live cycle occupies, which is the shape #1257 was reported against.
 *
 * A plain constant rather than a function of batchSize on purpose: the
 * previous shape took a batchSize it could not act on (the clamp swallowed
 * every value) and documented a floor that never fired. If CYCLE_BUDGET_MS
 * changes this moves with it, and the cron's maxDuration must stay
 * comfortably above it.
 */
const STUCK_IN_FLIGHT_AFTER_MS = CYCLE_BUDGET_MS + REQUEST_TIMEOUT_MS + STUCK_RECOVERY_SLACK_MS

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
  /** Claimed but no longer ours by the time the attempt was due to start. */
  skipped: number
  /** Claimed but handed back unattempted because the cycle budget ran out. */
  released: number
  /** Rows this tick's sweep pulled out of an abandoned in_flight state. */
  recovered: number
  /** Subset of `recovered` the sweep took terminal (attempts exhausted). */
  recoveredDead: number
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
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE
  const now = args.now ?? new Date()
  const pinnedFetchImpl = args.pinnedFetchImpl ?? pinnedHttpsFetch

  const summary: DispatchSummary = {
    picked: 0,
    delivered: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
    released: 0,
    recovered: 0,
    recoveredDead: 0,
  }

  // Recover stuck in_flight rows: a previous tick that was killed mid-flight
  // (Vercel function timeout, hard crash, manual termination) leaves rows
  // marked in_flight forever otherwise. Sweep them back to 'failed' so the
  // retry loop picks them up at next_attempt_at, on the same backoff schedule
  // a normal failed attempt gets.
  //
  // The window is STUCK_IN_FLIGHT_AFTER_MS: the bounded cycle
  // (CYCLE_BUDGET_MS, backed by the route's maxDuration) plus one receiver
  // timeout plus slack. It is deliberately WIDER than any live cycle can be,
  // so a row still queued behind an earlier cycle's serial loop is never
  // re-armed under it (#1257). The old fixed 2x REQUEST_TIMEOUT_MS was
  // narrower than a single cycle, which made every cycle recover the rows
  // the previous cycle was still working through.
  const recovery = await recoverStuckInFlight(args.supabase, now)
  summary.recovered = recovery.recovered
  summary.recoveredDead = recovery.dead

  // Real clock, not the injectable `now`: the budget bounds this invocation's
  // wall time, so a fixed test `now` must not be able to trip it.
  const cycleStartedAt = Date.now()

  const due = await claimDueDeliveries(args.supabase, batchSize, now)
  summary.picked = due.length
  if (due.length === 0) return summary

  // Dedupe webhook lookups within a single cycle.
  const webhookIds = Array.from(new Set(due.map((d) => d.webhook_id)))
  const webhookMap = await loadWebhooksByIds(args.supabase, webhookIds)

  for (const [index, delivery] of due.entries()) {
    // Out of budget: hand back everything we will not reach rather than
    // letting the platform kill the invocation mid-loop and leaving the
    // remainder stranded in in_flight until a sweep re-arms it.
    if (Date.now() - cycleStartedAt >= CYCLE_BUDGET_MS - REQUEST_TIMEOUT_MS) {
      const remaining = due.slice(index)
      await releaseUnattempted(
        args.supabase,
        remaining.map((d) => ({ id: d.id, attempts: d.attempts })),
        now,
      )
      summary.released = remaining.length
      log.warn('cycle budget exhausted: unattempted claims released', {
        count: remaining.length,
      })
      break
    }

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

    // Re-stamp updated_at immediately before this row's own attempt, so the
    // row's in_flight age measures the attempt rather than the claim, and use
    // the same write as an ownership check (#1257).
    if (!(await touchInFlight(args.supabase, delivery.id))) {
      log.info('delivery skipped: no longer in_flight', {
        deliveryId: delivery.id,
        webhookId: webhook.id,
        companyId: delivery.company_id,
      })
      summary.skipped++
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
          await disableWebhook(args.supabase, webhook.id, webhook.company_id, outcome.reason)
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
 * Sweep in_flight rows whose updated_at is older than the stuck-threshold
 * back into the retry queue, charging an attempt for the stall so
 * MAX_ATTEMPTS stays a real cap. Best-effort: a failure here is logged but
 * doesn't block the rest of the cycle.
 *
 * The predicate now lives in SQL (recover_stuck_webhook_deliveries,
 * migration 20260730123000) rather than in a PostgREST chain, because
 * PostgREST can express neither `attempts = attempts + 1` nor the
 * conditional flip to 'dead' at the cap, and a read-then-write loop would
 * reopen a TOCTOU against enforce_webhook_delivery_immutability. MAX_ATTEMPTS
 * and RETRY_BACKOFF_SECONDS are passed in so the cap AND the schedule stay
 * single-sourced here in TS.
 *
 * A swept row is re-armed on the SAME backoff the normal failure path uses
 * (markFailedForRetry), not immediately: a row that keeps getting stranded
 * (deploy, instance recycle, a cycle that outlives its invocation) would
 * otherwise be re-claimed on the very next per-minute tick, and could burn
 * all MAX_ATTEMPTS in under half an hour and land in the terminal, immutable
 * 'dead' state without its receiver ever having been contacted. The ~87 h
 * retry schedule is the delivery guarantee; the sweep must not shorten it.
 *
 * Under READ COMMITTED (Postgres default), UPDATE re-evaluates the WHERE
 * clause against each row's current value when it acquires the row lock.
 * The function keeps `status = 'in_flight'` in the outer UPDATE's WHERE for
 * exactly that reason: a row that raced from 'in_flight' to
 * 'delivered'/'dead' between scan and lock fails re-evaluation and is
 * skipped entirely, so the immutability trigger never fires and a mid-flight
 * terminal flip cannot abort the sweep.
 */
async function recoverStuckInFlight(
  supabase: SupabaseClient,
  now: Date,
): Promise<{ recovered: number; dead: number }> {
  const stuckBefore = new Date(now.getTime() - STUCK_IN_FLIGHT_AFTER_MS)
  const { data, error } = await supabase.rpc('recover_stuck_webhook_deliveries', {
    p_stuck_before: stuckBefore.toISOString(),
    p_max_attempts: MAX_ATTEMPTS,
    p_backoff: [...RETRY_BACKOFF_SECONDS],
    p_now: now.toISOString(),
  })

  if (error) {
    log.warn('stuck in_flight recovery failed', { code: error.code })
    return { recovered: 0, dead: 0 }
  }
  const rows = (data ?? []) as Array<{ id: string; status: string; attempts: number }>
  const dead = rows.filter((r) => r.status === 'dead').length
  if (rows.length > 0) {
    log.warn('recovered stuck in_flight rows', {
      count: rows.length,
      dead,
      retrying: rows.length - dead,
    })
  }
  // Counts are returned as well as logged: a tick that takes deliveries
  // terminal is the event worth alerting on, and it must be visible in the
  // cron's own summary line rather than only in a helper-level warn.
  return { recovered: rows.length, dead }
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

/**
 * Re-stamp a claimed row's updated_at right before its own attempt starts,
 * and report whether the row is still ours.
 *
 * `status` is written back verbatim: Postgres runs the UPDATE regardless of
 * whether any value changed, so the table's BEFORE UPDATE
 * update_updated_at_column trigger (migration 20260515200000) re-stamps
 * updated_at. That is what makes a row's in_flight age measure its attempt
 * instead of the moment the whole batch was claimed, which is the property
 * the stuck sweep reads.
 *
 * The `.eq('status', 'in_flight')` filter keeps the write off terminal rows,
 * so enforce_webhook_delivery_immutability never fires. A zero-row result
 * means the delivery is no longer ours (another cycle recovered and re-claimed
 * it, or it already reached a terminal state): skip it rather than POSTing a
 * duplicate whose terminal write would lose the race anyway.
 */
async function touchInFlight(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .update({ status: 'in_flight' })
    .eq('id', id)
    .eq('status', 'in_flight')
    .select('id')

  if (error) {
    // Infrastructure hiccup, not lost ownership: proceed. Worst case the row
    // looks older than it is and a later sweep re-arms it, which is exactly
    // the pre-existing behaviour.
    log.warn('in_flight touch failed', { id, code: error.code })
    return true
  }
  return (data?.length ?? 0) > 0
}

/**
 * Hand back rows this cycle claimed but will not attempt, so they are
 * re-claimable immediately instead of waiting out the stuck window.
 *
 * Deliberately does NOT bump attempts (these rows were never attempted) and
 * deliberately does NOT write `error` (a release is not a failure; overwriting
 * would destroy the previous attempt's diagnostic).
 *
 * The status written back is the row's PRE-CLAIM status, reconstructed from
 * `attempts` rather than guessed: claim_due_webhook_deliveries accepts
 * status IN ('pending','failed'), and every path that writes 'failed' also
 * writes attempts >= 1 (markFailedForRetry, the recovery sweep), while rows
 * enter the table as 'pending' with attempts = 0. So attempts = 0 means the
 * row was 'pending' and must go back to 'pending'. This matters because
 * webhook_deliveries is behandlingshistorik (BFNAR 2013:2 kap 8 §) exposed on
 * GET /webhooks/{id}/deliveries: a brand-new delivery that was claimed and
 * handed back without a single POST must not read as 'failed' to the
 * customer. Restoring the status verbatim would need the claim RPC to return
 * it, which it does not; the attempts inference gets the same answer without
 * changing a shipped function.
 */
async function releaseUnattempted(
  supabase: SupabaseClient,
  rows: Array<{ id: string; attempts: number }>,
  now: Date,
): Promise<void> {
  if (rows.length === 0) return

  const byPriorStatus: Array<{ status: 'pending' | 'failed'; ids: string[] }> = [
    { status: 'pending', ids: rows.filter((r) => r.attempts === 0).map((r) => r.id) },
    { status: 'failed', ids: rows.filter((r) => r.attempts > 0).map((r) => r.id) },
  ]

  for (const group of byPriorStatus) {
    if (group.ids.length === 0) continue
    const { error } = await supabase
      .from('webhook_deliveries')
      .update({ status: group.status, next_attempt_at: now.toISOString() })
      .in('id', group.ids)
      .eq('status', 'in_flight')
    if (error) {
      log.warn('release of unattempted claims failed', {
        count: group.ids.length,
        status: group.status,
        code: error.code,
      })
    }
  }
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
  companyId: string,
  reason: string,
): Promise<void> {
  // Snapshot before the disable so the audit entry can record the prior
  // state. Service-role read; bypasses RLS.
  //
  // `webhooks` has NO user_id column: the legacy automation_webhooks table
  // never had one and webhooks_v2 (20260515170000) didn't add one. Tenancy
  // lives on company_id (NOT NULL) and the only actor attribution is
  // created_by_api_key_id. Selecting a phantom column makes PostgREST fail
  // the ENTIRE read (42703), which previously left `prior` null and the
  // audit row unscoped, so the read error is checked and logged here rather
  // than silently degrading to a null snapshot.
  const { data: prior, error: priorErr } = await supabase
    .from('webhooks')
    .select('company_id, name, active, disabled_at, disabled_reason')
    .eq('id', webhookId)
    .maybeSingle()
  if (priorErr) {
    log.warn('webhook prior-state snapshot failed', { webhookId, code: priorErr.code })
  }

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
  // the dispatcher cron itself, not by a human caller or a credential:
  // user_id and actor_id stay null and the attribution is carried by
  // actor_type/actor_label instead ('system' is in the
  // audit_log_actor_type_check allowlist; same vocabulary the
  // commit_journal_entry audit row uses, migration 20260619120000).
  //
  // company_id comes from the webhook row the dispatch loop already
  // loaded and tenancy-checked against the delivery: the audit row keeps
  // its company scope even when the prior-state snapshot read fails, so
  // it stays visible to the per-company audit trail (getAuditLog filters
  // on company_id).
  //
  // The entry is written UNCONDITIONALLY (even when prior is null)
  // because the SECURITY_EVENT must produce a durable record
  // (A.8.15 / V16.1.1 / CC7.2).
  //
  // The reason discriminates between the three auto-disable paths
  // (http_410_gone / redirect_blocked / url_unsafe:<class>) so SIEM
  // tooling can alert on systematic patterns.
  const p = prior as {
    company_id: string | null
    name: string
    active: boolean
    disabled_at: string | null
    disabled_reason: string | null
  } | null

  const { error: auditErr } = await supabase.from('audit_log').insert({
    user_id: null,
    company_id: companyId,
    action: 'SECURITY_EVENT',
    table_name: 'webhooks',
    record_id: webhookId,
    actor_id: null,
    actor_type: 'system',
    actor_label: 'webhook-dispatcher',
    description: p
      ? `Webhook auto-disabled by dispatcher: ${reason} (was "${p.name}")`
      : `Webhook auto-disabled by dispatcher: ${reason} (prior snapshot unavailable)`,
    old_state: p
      ? { active: p.active, disabled_at: p.disabled_at, disabled_reason: p.disabled_reason }
      : null,
    new_state: { active: false, disabled_reason: reason, disabled_at: new Date().toISOString() },
  })
  if (auditErr) {
    // Escalated from warn to error on purpose. Webhook registrations are
    // NOT statutory räkenskapsinformation (BFL/BFNAR do not reach them:
    // see the classification in migration 20260515170000), so a dropped
    // row here is an operational audit-integrity gap, not a legal one,
    // and the dispatch cycle must not abort over it. But warn is
    // suppressed in prod-adjacent noise filters and never reaches the
    // observability sink, which made this a silent gap; error always
    // forwards (lib/logger.ts) so the missing SECURITY_EVENT is alertable
    // (CC7.2).
    log.error(
      'audit_log insert failed for webhook auto-disable',
      new Error(auditErr.message ?? 'audit_log insert failed'),
      { webhookId, companyId, reason, code: auditErr.code },
    )
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
  DEFAULT_BATCH_SIZE,
  CYCLE_BUDGET_MS,
  STUCK_RECOVERY_SLACK_MS,
  STUCK_IN_FLIGHT_AFTER_MS,
}
