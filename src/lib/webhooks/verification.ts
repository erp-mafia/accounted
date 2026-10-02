/**
 * Webhook endpoint ownership verification (ADA CASA 7.1.2, #3191).
 *
 * Before Accounted delivers events to a URL, the URL has to prove that whoever
 * runs it wants them: a challenge-response handshake.
 *
 * Request: a POST to the webhook_url, signed exactly like a normal delivery
 * (X-Gnubok-Signature over `${t}.${rawBody}` with the webhook's own secret),
 * with X-Gnubok-Event: webhook.verification and the standard envelope:
 *
 *   { "id": "<attempt uuid>", "type": "webhook.verification",
 *     "api_version": "...", "created": <unix>,
 *     "data": { "object": { "webhook_id": "...", "challenge": "<random>" } },
 *     "previous_attributes": null }
 *
 * Expected answer, within 10 seconds, no redirects: any 2xx status with the
 * JSON body {"challenge": "<the same value>"} (top-level key; the response
 * is at most 4 KB). Anything else fails the attempt.
 *
 * The challenge sits inside data.object but must come back at the top level
 * on purpose: an echo service that reflects any request body verbatim, or
 * wraps it in its own envelope, cannot pass without the endpoint's owner
 * writing the handler.
 *
 * The handshake is synchronous: challenge generated, sent and compared inside
 * one call, so it is never stored anywhere. The webhooks row records only the
 * outcome (migration 20260929172450_webhook_endpoint_verification.sql), and a
 * guard trigger resets it whenever webhook_url changes.
 *
 * Who attempts it:
 *   - POST /webhooks/{id}/verify (manual, synchronous, answers with the result)
 *   - the per-minute dispatch cron (runDueVerifications): new and changed URLs
 *     after 1m, 5m, 30m, 2h, 12h, then daily, 8 attempts in all; endpoints in
 *     the legacy grace window daily until the window closes.
 *
 * Delivery gate: events are enqueued and dispatched only while the endpoint
 * is verified, or unverified but inside its grace window (existing endpoints
 * at the time of the migration: 30 days).
 */

import crypto from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { signPayload } from './signing'
import { pinnedHttpsFetch, type PinnedFetchResult } from './pinned-fetch'
import { createLogger } from '@/lib/logger'

const log = createLogger('webhooks/verification')

export const VERIFICATION_EVENT_TYPE = 'webhook.verification'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BODY_BYTES = 4096

/** Delay before automatic attempt n+1, indexed by n-1; the last entry repeats. */
export const VERIFICATION_BACKOFF_SECONDS: ReadonlyArray<number> = [
  60, // 1m
  5 * 60, // 5m
  30 * 60, // 30m
  2 * 60 * 60, // 2h
  12 * 60 * 60, // 12h
  24 * 60 * 60, // then daily
]

/**
 * Automatic attempts for an endpoint outside a grace window (about 2.6 days
 * on the schedule above). Inside the window attempts continue daily, because
 * events are riding on the endpoint and the owner can ship the handler any day.
 */
export const MAX_AUTOMATIC_ATTEMPTS = 8

/** A manual attempt within this many seconds of the previous one is refused. */
export const MANUAL_VERIFY_COOLDOWN_SECONDS = 10

/** Handshakes the cron runs per tick, in parallel. */
const SWEEP_LIMIT = 5

/** How long a cron claim holds a row before another tick may retry it. */
const SWEEP_LEASE_SECONDS = 5 * 60

/** Verification columns every webhook read surface returns. */
export const WEBHOOK_VERIFICATION_COLUMNS =
  'verified_at, verification_grace_ends_at, verification_attempts, verification_last_attempt_at, verification_last_error, verification_next_attempt_at'

export const WEBHOOK_VERIFICATION_STATUSES = ['verified', 'pending', 'grace_period', 'paused'] as const

export type WebhookVerificationStatus = (typeof WEBHOOK_VERIFICATION_STATUSES)[number]

/**
 * Response fields every v1 webhook read carries (list, detail, create, update,
 * verify). One shape so the OpenAPI spec and the generated skill describe the
 * state the same way on every endpoint.
 */
export const WEBHOOK_VERIFICATION_RESPONSE_FIELDS = {
  verification_status: z.enum(WEBHOOK_VERIFICATION_STATUSES),
  verified_at: z.string().nullable(),
  verification_grace_ends_at: z.string().nullable(),
  verification_attempts: z.number().int(),
  verification_last_attempt_at: z.string().nullable(),
  verification_last_error: z.string().nullable(),
  verification_next_attempt_at: z.string().nullable(),
}

export interface VerificationTimestamps {
  verified_at: string | null
  verification_grace_ends_at: string | null
}

/**
 * verified: the current URL passed the handshake.
 * pending: a new or changed URL that has not passed yet; nothing is delivered.
 * grace_period: an endpoint that existed before verification shipped, still
 *   receiving events until verification_grace_ends_at.
 * paused: the same endpoint after its window closed; nothing is delivered
 *   until it passes the handshake.
 */
export function webhookVerificationStatus(
  webhook: VerificationTimestamps,
  now: Date = new Date(),
): WebhookVerificationStatus {
  if (webhook.verified_at) return 'verified'
  if (!webhook.verification_grace_ends_at) return 'pending'
  return new Date(webhook.verification_grace_ends_at).getTime() > now.getTime()
    ? 'grace_period'
    : 'paused'
}

/** True when events may be enqueued for and delivered to this endpoint. */
export function verificationAllowsDelivery(
  webhook: VerificationTimestamps,
  now: Date = new Date(),
): boolean {
  const status = webhookVerificationStatus(webhook, now)
  return status === 'verified' || status === 'grace_period'
}

/** A webhook row as the API returns it: the stored columns plus the derived status. */
export function withVerificationStatus<T extends VerificationTimestamps>(
  row: T,
  now: Date = new Date(),
): T & { verification_status: WebhookVerificationStatus } {
  return { ...row, verification_status: webhookVerificationStatus(row, now) }
}

/**
 * When the cron should try again after a failed attempt, or null when
 * automatic attempts stop (the owner then calls POST /webhooks/{id}/verify).
 */
export function nextAutomaticAttemptAt(
  attempts: number,
  now: Date,
  graceEndsAt: string | null,
): string | null {
  const graceActive = graceEndsAt !== null && new Date(graceEndsAt).getTime() > now.getTime()
  if (!graceActive && attempts >= MAX_AUTOMATIC_ATTEMPTS) return null
  const index = Math.min(Math.max(attempts, 1) - 1, VERIFICATION_BACKOFF_SECONDS.length - 1)
  return new Date(now.getTime() + VERIFICATION_BACKOFF_SECONDS[index] * 1000).toISOString()
}

/** 256 bits from the CSPRNG, URL-safe: 43 characters. */
export function generateChallenge(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function buildVerificationRequest(args: {
  webhookId: string
  apiVersion: string
  secret: string
  challenge: string
  attemptId: string
  now: Date
}): { body: string; headers: Record<string, string> } {
  const created = Math.floor(args.now.getTime() / 1000)
  const body = JSON.stringify({
    id: args.attemptId,
    type: VERIFICATION_EVENT_TYPE,
    api_version: args.apiVersion,
    created,
    data: { object: { webhook_id: args.webhookId, challenge: args.challenge } },
    previous_attributes: null,
  })
  const { header } = signPayload({ body, secret: args.secret, timestamp: created })
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-Gnubok-Signature': header,
      'X-Gnubok-Event': VERIFICATION_EVENT_TYPE,
      'X-Gnubok-Delivery': args.attemptId,
      'X-Gnubok-Api-Version': args.apiVersion,
      'X-Request-Id': `whver_${args.attemptId}`,
      'User-Agent': 'gnubok-webhook/1',
    },
  }
}

export type VerificationVerdict =
  | { ok: true }
  | { ok: false; reason: string; detail?: string }

function challengesMatch(received: string, expected: string): boolean {
  // Hash both sides to equal-length digests so the comparison is constant-time
  // regardless of what length the endpoint sent back.
  const a = crypto.createHash('sha256').update(received, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

/** Decide whether one handshake response proves ownership. Pure. */
export function evaluateVerificationResponse(
  result: PinnedFetchResult,
  challenge: string,
): VerificationVerdict {
  switch (result.kind) {
    case 'unsafe_url':
      return { ok: false, reason: `url_unsafe:${result.reason}`, detail: result.detail }
    case 'redirect_blocked':
      return { ok: false, reason: 'redirect_blocked', detail: `HTTP ${result.status}` }
    case 'timeout':
      return { ok: false, reason: 'timeout' }
    case 'transport_error':
      return { ok: false, reason: 'transport_error', detail: result.detail }
    case 'ok': {
      if (result.status < 200 || result.status >= 300) {
        return { ok: false, reason: `http_${result.status}` }
      }
      if (result.bodyTruncated) return { ok: false, reason: 'response_too_large' }
      let parsed: unknown
      try {
        parsed = JSON.parse(result.body)
      } catch {
        return { ok: false, reason: 'response_not_json' }
      }
      const echoed =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).challenge
          : undefined
      if (typeof echoed !== 'string') return { ok: false, reason: 'challenge_missing' }
      if (!challengesMatch(echoed, challenge)) return { ok: false, reason: 'challenge_mismatch' }
      return { ok: true }
    }
  }
}

function formatFailure(verdict: { reason: string; detail?: string }): string {
  const text = verdict.detail ? `${verdict.reason}: ${verdict.detail}` : verdict.reason
  return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

export interface VerifiableWebhook {
  id: string
  company_id: string
  webhook_url: string
  secret: string
  api_version_pinned: string
  verification_attempts: number
  verification_grace_ends_at: string | null
}

export type VerificationActor =
  | { kind: 'cron' }
  | { kind: 'api_key'; userId: string; apiKeyId: string | null }

export type VerificationOutcome =
  | { kind: 'verified'; verifiedAt: string }
  | { kind: 'failed'; reason: string; error: string; nextAttemptAt: string | null }
  /** The URL changed or another attempt verified it meanwhile: nothing recorded. */
  | { kind: 'superseded' }

/**
 * Run one handshake against the webhook's current URL and record the result.
 *
 * Both writes are conditional on the URL still being the one that was
 * contacted and on the row still being unverified: an answer from a URL the
 * owner has since replaced must never verify the replacement.
 */
export async function attemptWebhookVerification(args: {
  supabase: SupabaseClient
  webhook: VerifiableWebhook
  actor: VerificationActor
  now?: Date
  pinnedFetchImpl?: typeof pinnedHttpsFetch
}): Promise<VerificationOutcome> {
  const { supabase, webhook, actor } = args
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()
  const pinnedFetchImpl = args.pinnedFetchImpl ?? pinnedHttpsFetch

  const challenge = generateChallenge()
  const attemptId = crypto.randomUUID()
  const request = buildVerificationRequest({
    webhookId: webhook.id,
    apiVersion: webhook.api_version_pinned,
    secret: webhook.secret,
    challenge,
    attemptId,
    now,
  })

  // Same DNS-rebinding-safe, redirect-refusing, SSRF-guarded transport as
  // every delivery: the handshake is itself a request to a URL nobody has
  // vouched for yet.
  const result = await pinnedFetchImpl(webhook.webhook_url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BODY_BYTES,
  })
  const verdict = evaluateVerificationResponse(result, challenge)
  const attempts = webhook.verification_attempts + 1
  const logCtx = { webhookId: webhook.id, companyId: webhook.company_id, attempt: attempts, actor: actor.kind }

  if (verdict.ok) {
    const { data, error } = await supabase
      .from('webhooks')
      .update({
        verified_at: nowIso,
        verification_attempts: attempts,
        verification_last_attempt_at: nowIso,
        verification_last_error: null,
        verification_next_attempt_at: null,
      })
      .eq('id', webhook.id)
      .eq('company_id', webhook.company_id)
      .eq('webhook_url', webhook.webhook_url)
      .is('verified_at', null)
      .select('id')
    if (error) throw error
    if (!data || data.length === 0) {
      log.info('verification passed but superseded', logCtx)
      return { kind: 'superseded' }
    }
    log.info('webhook endpoint verified', logCtx)
    await writeVerifiedAudit(supabase, webhook, actor, nowIso)
    return { kind: 'verified', verifiedAt: nowIso }
  }

  const error = formatFailure(verdict)
  const nextAttemptAt = nextAutomaticAttemptAt(attempts, now, webhook.verification_grace_ends_at)
  const { data, error: updateErr } = await supabase
    .from('webhooks')
    .update({
      verification_attempts: attempts,
      verification_last_attempt_at: nowIso,
      verification_last_error: error,
      verification_next_attempt_at: nextAttemptAt,
    })
    .eq('id', webhook.id)
    .eq('company_id', webhook.company_id)
    .eq('webhook_url', webhook.webhook_url)
    .is('verified_at', null)
    .select('id')
  if (updateErr) throw updateErr
  if (!data || data.length === 0) return { kind: 'superseded' }
  log.info('webhook verification failed', { ...logCtx, reason: verdict.reason })
  return { kind: 'failed', reason: verdict.reason, error, nextAttemptAt }
}

/**
 * Audit trail for the moment a URL became eligible for deliveries (V16 /
 * A.8.15). A failed audit write never undoes the verification; it is logged at
 * error level so the gap is alertable, as the dispatcher does for auto-disable.
 */
async function writeVerifiedAudit(
  supabase: SupabaseClient,
  webhook: VerifiableWebhook,
  actor: VerificationActor,
  verifiedAt: string,
): Promise<void> {
  const { error } = await supabase.from('audit_log').insert({
    user_id: actor.kind === 'api_key' ? actor.userId : null,
    company_id: webhook.company_id,
    action: 'UPDATE',
    table_name: 'webhooks',
    record_id: webhook.id,
    actor_id: actor.kind === 'api_key' ? actor.apiKeyId : null,
    actor_type: actor.kind === 'api_key' ? 'api_key' : 'cron',
    actor_label: actor.kind === 'api_key' ? null : 'webhook-verification',
    description: `Webhook endpoint verified by challenge-response: ${webhook.webhook_url}`,
    new_state: { webhook_url: webhook.webhook_url, verified_at: verifiedAt },
  })
  if (error) {
    log.error('audit_log insert failed for webhook verification', new Error(error.message ?? 'audit_log insert failed'), {
      webhookId: webhook.id,
      companyId: webhook.company_id,
      code: error.code,
    })
  }
}

export interface VerificationSweepSummary {
  picked: number
  verified: number
  failed: number
  /** Due but claimed by a concurrent run, or superseded mid-attempt. */
  skipped: number
}

/**
 * The cron half: attempt every due handshake (up to SWEEP_LIMIT per tick, in
 * parallel so one slow endpoint costs one timeout, not five). Each row is
 * claimed with a conditional UPDATE that moves verification_next_attempt_at
 * onto a lease first, so an overlapping tick cannot contact the same URL
 * twice; a run that dies mid-attempt leaves a lease that simply expires.
 */
export async function runDueVerifications(args: {
  supabase: SupabaseClient
  now?: Date
  limit?: number
  pinnedFetchImpl?: typeof pinnedHttpsFetch
}): Promise<VerificationSweepSummary> {
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()
  const summary: VerificationSweepSummary = { picked: 0, verified: 0, failed: 0, skipped: 0 }

  const { data, error } = await args.supabase
    .from('webhooks')
    .select('id, company_id, webhook_url, secret, api_version_pinned, verification_attempts, verification_grace_ends_at')
    .is('verified_at', null)
    .lte('verification_next_attempt_at', nowIso)
    .eq('active', true)
    .is('disabled_at', null)
    .order('verification_next_attempt_at', { ascending: true })
    .limit(args.limit ?? SWEEP_LIMIT)
  if (error) {
    log.warn('due verification lookup failed', { code: error.code })
    return summary
  }
  const due = (data ?? []) as VerifiableWebhook[]
  summary.picked = due.length
  if (due.length === 0) return summary

  const lease = new Date(now.getTime() + SWEEP_LEASE_SECONDS * 1000).toISOString()
  const claimed: VerifiableWebhook[] = []
  for (const webhook of due) {
    const { data: claim, error: claimErr } = await args.supabase
      .from('webhooks')
      .update({ verification_next_attempt_at: lease, verification_last_attempt_at: nowIso })
      .eq('id', webhook.id)
      .is('verified_at', null)
      .lte('verification_next_attempt_at', nowIso)
      .select('id')
    if (claimErr || !claim || claim.length === 0) {
      summary.skipped++
      continue
    }
    claimed.push(webhook)
  }

  const outcomes = await Promise.allSettled(
    claimed.map((webhook) =>
      attemptWebhookVerification({
        supabase: args.supabase,
        webhook,
        actor: { kind: 'cron' },
        now,
        pinnedFetchImpl: args.pinnedFetchImpl,
      }),
    ),
  )
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'rejected') {
      // The lease stays on the row, so the next tick after it expires retries.
      summary.failed++
      log.warn('verification attempt errored', {
        webhookId: claimed[index].id,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      })
      continue
    }
    if (outcome.value.kind === 'verified') summary.verified++
    else if (outcome.value.kind === 'failed') summary.failed++
    else summary.skipped++
  }
  return summary
}

export type ManualVerificationResult =
  | { kind: 'not_found' }
  | { kind: 'disabled' }
  | { kind: 'already_verified' }
  | { kind: 'cooldown'; retryAfterSeconds: number }
  | { kind: 'verified' }
  | { kind: 'failed'; reason: string; error: string }
  | { kind: 'superseded' }

/**
 * The manual half, behind POST /webhooks/{id}/verify. Refuses a disabled
 * webhook (re-enable first, as for :test), answers an already verified one
 * without contacting it, and allows one attempt per webhook per
 * MANUAL_VERIFY_COOLDOWN_SECONDS: the cooldown is claimed with a conditional
 * UPDATE, so two concurrent calls cannot both reach the endpoint.
 */
export async function verifyWebhookNow(args: {
  supabase: SupabaseClient
  companyId: string
  webhookId: string
  actor: { userId: string; apiKeyId: string | null }
  now?: Date
  pinnedFetchImpl?: typeof pinnedHttpsFetch
}): Promise<ManualVerificationResult> {
  const now = args.now ?? new Date()
  const nowIso = now.toISOString()

  const { data, error } = await args.supabase
    .from('webhooks')
    .select(
      'id, company_id, webhook_url, secret, api_version_pinned, verification_attempts, verification_grace_ends_at, active, disabled_at, verified_at, verification_last_attempt_at'
    )
    .eq('company_id', args.companyId)
    .eq('id', args.webhookId)
    .maybeSingle()
  if (error) throw error
  if (!data) return { kind: 'not_found' }
  const webhook = data as VerifiableWebhook & {
    active: boolean
    disabled_at: string | null
    verified_at: string | null
    verification_last_attempt_at: string | null
  }
  if (!webhook.active || webhook.disabled_at) return { kind: 'disabled' }
  if (webhook.verified_at) return { kind: 'already_verified' }

  const cooldownMs = MANUAL_VERIFY_COOLDOWN_SECONDS * 1000
  if (webhook.verification_last_attempt_at) {
    const sinceLast = now.getTime() - new Date(webhook.verification_last_attempt_at).getTime()
    if (sinceLast < cooldownMs) {
      return { kind: 'cooldown', retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - sinceLast) / 1000)) }
    }
  }

  // Compare-and-set on the last_attempt_at value just read (passed back
  // verbatim, full precision): a concurrent attempt that started in between
  // has moved it, so this call matches no row and backs off.
  const claimQuery = args.supabase
    .from('webhooks')
    .update({ verification_last_attempt_at: nowIso })
    .eq('id', webhook.id)
    .eq('company_id', args.companyId)
    .eq('webhook_url', webhook.webhook_url)
    .is('verified_at', null)
  const { data: claim, error: claimErr } = await (webhook.verification_last_attempt_at
    ? claimQuery.eq('verification_last_attempt_at', webhook.verification_last_attempt_at)
    : claimQuery.is('verification_last_attempt_at', null)
  ).select('id')
  if (claimErr) throw claimErr
  if (!claim || claim.length === 0) {
    return { kind: 'cooldown', retryAfterSeconds: MANUAL_VERIFY_COOLDOWN_SECONDS }
  }

  const outcome = await attemptWebhookVerification({
    supabase: args.supabase,
    webhook,
    actor: { kind: 'api_key', userId: args.actor.userId, apiKeyId: args.actor.apiKeyId },
    now,
    pinnedFetchImpl: args.pinnedFetchImpl,
  })
  if (outcome.kind === 'verified') return { kind: 'verified' }
  if (outcome.kind === 'failed') return { kind: 'failed', reason: outcome.reason, error: outcome.error }
  return { kind: 'superseded' }
}

export const __TESTING__ = {
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  SWEEP_LIMIT,
  SWEEP_LEASE_SECONDS,
}
