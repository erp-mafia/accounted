/**
 * Endpoint ownership handshake (ADA CASA 7.1.2, #3191).
 *
 * The contract integrators build against: a signed webhook.verification POST
 * carrying data.object.challenge, passed only by a 2xx whose JSON body is
 * {"challenge": "<the same value>"}. Everything else (wrong echo, missing
 * echo, a verbatim echo of the request, 404, timeout, redirect, unsafe URL)
 * fails the attempt and is recorded, never verified.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PinnedFetchInit, PinnedFetchResult } from '../pinned-fetch'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
}))

import {
  MAX_AUTOMATIC_ATTEMPTS,
  MANUAL_VERIFY_COOLDOWN_SECONDS,
  VERIFICATION_BACKOFF_SECONDS,
  VERIFICATION_EVENT_TYPE,
  attemptWebhookVerification,
  buildVerificationRequest,
  evaluateVerificationResponse,
  generateChallenge,
  nextAutomaticAttemptAt,
  runDueVerifications,
  verificationAllowsDelivery,
  verifyWebhookNow,
  webhookVerificationStatus,
  type VerifiableWebhook,
} from '../verification'
import { verifySignatureHeader } from '../signing'

const NOW = new Date('2026-10-01T10:00:00.000Z')
const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const WEBHOOK_ID = '22222222-2222-4222-8222-222222222222'
const SECRET = 'whsec_test_secret'

function webhook(overrides: Partial<VerifiableWebhook> = {}): VerifiableWebhook {
  return {
    id: WEBHOOK_ID,
    company_id: COMPANY_ID,
    webhook_url: 'https://receiver.example.com/hook',
    secret: SECRET,
    api_version_pinned: '2026-05-12',
    verification_attempts: 0,
    verification_grace_ends_at: null,
    ...overrides,
  }
}

function ok(status: number, body: string, bodyTruncated = false): PinnedFetchResult {
  return {
    kind: 'ok',
    status,
    headers: { 'content-type': 'application/json' },
    body,
    bodyTruncated,
    pinnedAddress: '203.0.113.10',
  }
}

/** A receiver that implements the contract: echo data.object.challenge. */
function echoingReceiver(status = 200) {
  return vi.fn(async (_url: string, init: PinnedFetchInit): Promise<PinnedFetchResult> => {
    const sent = JSON.parse(init.body) as { data: { object: { challenge: string } } }
    return ok(status, JSON.stringify({ challenge: sent.data.object.challenge }))
  })
}

// ──────────────────────────────────────────────────────────────────────
// A recording Supabase stub: every chain records its calls and resolves to
// the next queued response for `${table}.${operation}`.
// ──────────────────────────────────────────────────────────────────────

interface Call {
  table: string
  op: 'select' | 'update' | 'insert'
  payload: unknown
  filters: Array<[string, unknown[]]>
}

function makeSupabase(queues: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const start = (op: Call['op'], payload: unknown) => {
        const call: Call = { table, op, payload, filters: [] }
        calls.push(call)
        const chain: Record<string, unknown> = {}
        for (const method of ['eq', 'is', 'lte', 'in', 'order', 'limit', 'select', 'or']) {
          chain[method] = (...args: unknown[]) => {
            call.filters.push([method, args])
            return chain
          }
        }
        const resolveNext = () => {
          const queue = queues[`${table}.${op}`] ?? []
          const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? { data: null, error: null })
          return { data: next.data ?? null, error: next.error ?? null }
        }
        chain.maybeSingle = async () => resolveNext()
        chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(resolveNext()).then(resolve, reject)
        return chain
      }
      return {
        select: (cols: string) => start('select', cols),
        update: (payload: unknown) => start('update', payload),
        insert: (payload: unknown) => start('insert', payload),
      }
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

function filterValue(call: Call, method: string, column: string): unknown {
  const hit = call.filters.find(([m, args]) => m === method && args[0] === column)
  return hit ? hit[1][1] : undefined
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ──────────────────────────────────────────────────────────────────────

describe('verification status and delivery gate', () => {
  it('derives the four states from the timestamps', () => {
    expect(webhookVerificationStatus({ verified_at: NOW.toISOString(), verification_grace_ends_at: null }, NOW)).toBe('verified')
    expect(webhookVerificationStatus({ verified_at: null, verification_grace_ends_at: null }, NOW)).toBe('pending')
    expect(
      webhookVerificationStatus({ verified_at: null, verification_grace_ends_at: '2026-10-15T00:00:00Z' }, NOW),
    ).toBe('grace_period')
    expect(
      webhookVerificationStatus({ verified_at: null, verification_grace_ends_at: '2026-09-30T00:00:00Z' }, NOW),
    ).toBe('paused')
  })

  it('lets events through only for verified endpoints and legacy ones inside their window', () => {
    expect(verificationAllowsDelivery({ verified_at: NOW.toISOString(), verification_grace_ends_at: null }, NOW)).toBe(true)
    expect(verificationAllowsDelivery({ verified_at: null, verification_grace_ends_at: '2026-10-15T00:00:00Z' }, NOW)).toBe(true)
    // A brand-new endpoint gets nothing before it passes.
    expect(verificationAllowsDelivery({ verified_at: null, verification_grace_ends_at: null }, NOW)).toBe(false)
    // The window closes on time, with no job flipping state.
    expect(
      verificationAllowsDelivery({ verified_at: null, verification_grace_ends_at: NOW.toISOString() }, NOW),
    ).toBe(false)
  })
})

describe('nextAutomaticAttemptAt', () => {
  it('follows 1m, 5m, 30m, 2h, 12h, then daily', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempts) => {
      const next = nextAutomaticAttemptAt(attempts, NOW, null)
      return next ? (new Date(next).getTime() - NOW.getTime()) / 1000 : null
    })
    expect(delays).toEqual([60, 300, 1800, 7200, 43200, 86400, 86400])
    expect(VERIFICATION_BACKOFF_SECONDS.at(-1)).toBe(86400)
  })

  it('stops after the automatic budget when no grace window is running', () => {
    expect(nextAutomaticAttemptAt(MAX_AUTOMATIC_ATTEMPTS, NOW, null)).toBeNull()
    expect(nextAutomaticAttemptAt(MAX_AUTOMATIC_ATTEMPTS, NOW, '2026-09-01T00:00:00Z')).toBeNull()
  })

  it('keeps trying daily while a grace window is open', () => {
    const next = nextAutomaticAttemptAt(25, NOW, '2026-10-20T00:00:00Z')
    expect(next).toBe(new Date(NOW.getTime() + 86400 * 1000).toISOString())
  })
})

describe('buildVerificationRequest', () => {
  it('signs a webhook.verification envelope with the webhook secret, like any delivery', () => {
    const challenge = generateChallenge()
    const { body, headers } = buildVerificationRequest({
      webhookId: WEBHOOK_ID,
      apiVersion: '2026-05-12',
      secret: SECRET,
      challenge,
      attemptId: '33333333-3333-4333-8333-333333333333',
      now: NOW,
    })

    const parsed = JSON.parse(body)
    expect(parsed).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      type: VERIFICATION_EVENT_TYPE,
      api_version: '2026-05-12',
      created: Math.floor(NOW.getTime() / 1000),
      data: { object: { webhook_id: WEBHOOK_ID, challenge } },
      previous_attributes: null,
    })
    expect(headers['X-Gnubok-Event']).toBe('webhook.verification')
    expect(headers['X-Gnubok-Delivery']).toBe('33333333-3333-4333-8333-333333333333')
    const verified = verifySignatureHeader({
      header: headers['X-Gnubok-Signature'],
      rawBody: body,
      secret: SECRET,
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    })
    expect(verified).toEqual({ ok: true, timestamp: Math.floor(NOW.getTime() / 1000) })
  })

  it('draws a fresh 256-bit challenge every time', () => {
    const a = generateChallenge()
    const b = generateChallenge()
    expect(a).not.toBe(b)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
  })
})

describe('evaluateVerificationResponse: the contract', () => {
  const challenge = 'c'.repeat(43)

  it('accepts any 2xx whose JSON body echoes the challenge at the top level', () => {
    expect(evaluateVerificationResponse(ok(200, JSON.stringify({ challenge })), challenge)).toEqual({ ok: true })
    expect(evaluateVerificationResponse(ok(201, JSON.stringify({ challenge, extra: 1 })), challenge)).toEqual({ ok: true })
  })

  it('refuses a wrong echo', () => {
    expect(evaluateVerificationResponse(ok(200, JSON.stringify({ challenge: 'nope' })), challenge)).toEqual({
      ok: false,
      reason: 'challenge_mismatch',
    })
  })

  it('refuses a generic acknowledgement and a verbatim echo of the request body', () => {
    expect(evaluateVerificationResponse(ok(200, JSON.stringify({ ok: true })), challenge)).toMatchObject({
      reason: 'challenge_missing',
    })
    const requestBody = JSON.stringify({
      type: 'webhook.verification',
      data: { object: { webhook_id: WEBHOOK_ID, challenge } },
    })
    expect(evaluateVerificationResponse(ok(200, requestBody), challenge)).toMatchObject({
      reason: 'challenge_missing',
    })
    expect(evaluateVerificationResponse(ok(200, challenge), challenge)).toMatchObject({ reason: 'response_not_json' })
  })

  it('refuses non-2xx answers even when they carry the challenge', () => {
    expect(evaluateVerificationResponse(ok(404, JSON.stringify({ challenge })), challenge)).toEqual({
      ok: false,
      reason: 'http_404',
    })
    expect(evaluateVerificationResponse(ok(500, JSON.stringify({ challenge })), challenge)).toMatchObject({
      reason: 'http_500',
    })
  })

  it('refuses timeouts, redirects, transport errors, unsafe URLs and oversized bodies', () => {
    expect(evaluateVerificationResponse({ kind: 'timeout', detail: 'x', pinnedAddress: '203.0.113.10' }, challenge)).toEqual({
      ok: false,
      reason: 'timeout',
    })
    expect(
      evaluateVerificationResponse(
        { kind: 'redirect_blocked', status: 302, detail: 'x', pinnedAddress: '203.0.113.10' },
        challenge,
      ),
    ).toMatchObject({ reason: 'redirect_blocked' })
    expect(
      evaluateVerificationResponse({ kind: 'transport_error', detail: 'ECONNRESET', pinnedAddress: null }, challenge),
    ).toMatchObject({ reason: 'transport_error', detail: 'ECONNRESET' })
    expect(
      evaluateVerificationResponse(
        { kind: 'unsafe_url', reason: 'private_address', detail: '10.0.0.1', pinnedAddress: null },
        challenge,
      ),
    ).toMatchObject({ reason: 'url_unsafe:private_address' })
    expect(evaluateVerificationResponse(ok(200, '{"challenge":"', true), challenge)).toMatchObject({
      reason: 'response_too_large',
    })
  })
})

describe('attemptWebhookVerification', () => {
  it('verifies on a correct echo, conditional on the same URL still being unverified, and audits it', async () => {
    const { client, calls } = makeSupabase({ 'webhooks.update': [{ data: [{ id: WEBHOOK_ID }] }] })
    const fetch = echoingReceiver()

    const outcome = await attemptWebhookVerification({
      supabase: client,
      webhook: webhook(),
      actor: { kind: 'cron' },
      now: NOW,
      pinnedFetchImpl: fetch,
    })

    expect(outcome).toEqual({ kind: 'verified', verifiedAt: NOW.toISOString() })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://receiver.example.com/hook')
    expect(init.headers['X-Gnubok-Event']).toBe('webhook.verification')
    expect(init.timeoutMs).toBe(10_000)

    const update = calls.find((c) => c.table === 'webhooks' && c.op === 'update')!
    expect(update.payload).toMatchObject({
      verified_at: NOW.toISOString(),
      verification_attempts: 1,
      verification_last_error: null,
      verification_next_attempt_at: null,
    })
    // An answer from a URL the owner has since replaced must not verify the new one.
    expect(filterValue(update, 'eq', 'webhook_url')).toBe('https://receiver.example.com/hook')
    expect(filterValue(update, 'is', 'verified_at')).toBeNull()
    expect(filterValue(update, 'eq', 'company_id')).toBe(COMPANY_ID)

    const audit = calls.find((c) => c.table === 'audit_log')!
    expect(audit.payload).toMatchObject({
      company_id: COMPANY_ID,
      table_name: 'webhooks',
      record_id: WEBHOOK_ID,
      actor_type: 'cron',
    })
  })

  it('records a failure with the reason and schedules the next automatic attempt', async () => {
    const { client, calls } = makeSupabase({ 'webhooks.update': [{ data: [{ id: WEBHOOK_ID }] }] })
    const fetch = vi.fn(async () => ok(200, JSON.stringify({ challenge: 'wrong' })))

    const outcome = await attemptWebhookVerification({
      supabase: client,
      webhook: webhook({ verification_attempts: 2 }),
      actor: { kind: 'cron' },
      now: NOW,
      pinnedFetchImpl: fetch,
    })

    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'challenge_mismatch',
      error: 'challenge_mismatch',
      nextAttemptAt: new Date(NOW.getTime() + 1800 * 1000).toISOString(),
    })
    const update = calls.find((c) => c.op === 'update')!
    expect(update.payload).toMatchObject({
      verification_attempts: 3,
      verification_last_error: 'challenge_mismatch',
      verification_last_attempt_at: NOW.toISOString(),
    })
    expect(update.payload).not.toHaveProperty('verified_at')
    expect(calls.some((c) => c.table === 'audit_log')).toBe(false)
  })

  it('records nothing and reports superseded when the URL changed mid-attempt', async () => {
    const { client, calls } = makeSupabase({ 'webhooks.update': [{ data: [] }] })

    const outcome = await attemptWebhookVerification({
      supabase: client,
      webhook: webhook(),
      actor: { kind: 'api_key', userId: 'user-1', apiKeyId: 'ak_1' },
      now: NOW,
      pinnedFetchImpl: echoingReceiver(),
    })

    expect(outcome).toEqual({ kind: 'superseded' })
    expect(calls.some((c) => c.table === 'audit_log')).toBe(false)
  })

  it('treats a 404 or a timeout as a failed attempt', async () => {
    for (const result of [
      ok(404, 'not found'),
      { kind: 'timeout', detail: 'timed out', pinnedAddress: '203.0.113.10' } as PinnedFetchResult,
    ]) {
      const { client } = makeSupabase({ 'webhooks.update': [{ data: [{ id: WEBHOOK_ID }] }] })
      const outcome = await attemptWebhookVerification({
        supabase: client,
        webhook: webhook(),
        actor: { kind: 'cron' },
        now: NOW,
        pinnedFetchImpl: vi.fn(async () => result),
      })
      expect(outcome.kind).toBe('failed')
    }
  })
})

describe('runDueVerifications (cron)', () => {
  it('claims each due row with a lease before contacting it and skips rows another run claimed', async () => {
    const other = webhook({ id: '44444444-4444-4444-8444-444444444444', webhook_url: 'https://other.example.com/h' })
    const { client, calls } = makeSupabase({
      'webhooks.select': [{ data: [webhook(), other] }],
      'webhooks.update': [
        { data: [{ id: WEBHOOK_ID }] }, // claim 1: ours
        { data: [] }, // claim 2: lost to a concurrent run
        { data: [{ id: WEBHOOK_ID }] }, // result write for the claimed row
      ],
    })
    const fetch = echoingReceiver()

    const summary = await runDueVerifications({ supabase: client, now: NOW, pinnedFetchImpl: fetch })

    expect(summary).toEqual({ picked: 2, verified: 1, failed: 0, skipped: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
    const select = calls.find((c) => c.op === 'select')!
    expect(filterValue(select, 'is', 'verified_at')).toBeNull()
    expect(filterValue(select, 'lte', 'verification_next_attempt_at')).toBe(NOW.toISOString())
    expect(filterValue(select, 'eq', 'active')).toBe(true)
    const claim = calls.filter((c) => c.op === 'update')[0]
    expect(claim.payload).toEqual({
      verification_next_attempt_at: new Date(NOW.getTime() + 300_000).toISOString(),
      verification_last_attempt_at: NOW.toISOString(),
    })
    expect(filterValue(claim, 'lte', 'verification_next_attempt_at')).toBe(NOW.toISOString())
  })

  it('does nothing when no handshake is due', async () => {
    const { client } = makeSupabase({ 'webhooks.select': [{ data: [] }] })
    const fetch = echoingReceiver()
    expect(await runDueVerifications({ supabase: client, now: NOW, pinnedFetchImpl: fetch })).toEqual({
      picked: 0,
      verified: 0,
      failed: 0,
      skipped: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('verifyWebhookNow (manual)', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    ...webhook(),
    active: true,
    disabled_at: null,
    verified_at: null,
    verification_last_attempt_at: null,
    ...overrides,
  })
  const actor = { userId: 'user-1', apiKeyId: 'ak_1' }

  it('reports not_found and disabled without contacting anything', async () => {
    const fetch = echoingReceiver()
    const missing = makeSupabase({ 'webhooks.select': [{ data: null }] })
    expect(
      await verifyWebhookNow({ supabase: missing.client, companyId: COMPANY_ID, webhookId: WEBHOOK_ID, actor, now: NOW, pinnedFetchImpl: fetch }),
    ).toEqual({ kind: 'not_found' })
    const disabled = makeSupabase({ 'webhooks.select': [{ data: row({ active: false }) }] })
    expect(
      await verifyWebhookNow({ supabase: disabled.client, companyId: COMPANY_ID, webhookId: WEBHOOK_ID, actor, now: NOW, pinnedFetchImpl: fetch }),
    ).toEqual({ kind: 'disabled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers an already verified webhook without contacting it', async () => {
    const fetch = echoingReceiver()
    const { client } = makeSupabase({ 'webhooks.select': [{ data: row({ verified_at: '2026-09-30T00:00:00Z' }) }] })
    expect(
      await verifyWebhookNow({ supabase: client, companyId: COMPANY_ID, webhookId: WEBHOOK_ID, actor, now: NOW, pinnedFetchImpl: fetch }),
    ).toEqual({ kind: 'already_verified' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a repeat inside the cooldown with the seconds left', async () => {
    const fetch = echoingReceiver()
    const lastAttempt = new Date(NOW.getTime() - 3_000).toISOString()
    const { client } = makeSupabase({ 'webhooks.select': [{ data: row({ verification_last_attempt_at: lastAttempt }) }] })
    expect(
      await verifyWebhookNow({ supabase: client, companyId: COMPANY_ID, webhookId: WEBHOOK_ID, actor, now: NOW, pinnedFetchImpl: fetch }),
    ).toEqual({ kind: 'cooldown', retryAfterSeconds: MANUAL_VERIFY_COOLDOWN_SECONDS - 3 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('backs off when a concurrent attempt claimed the row first', async () => {
    const fetch = echoingReceiver()
    const lastAttempt = '2026-09-30T08:00:00.123456+00:00'
    const { client, calls } = makeSupabase({
      'webhooks.select': [{ data: row({ verification_last_attempt_at: lastAttempt }) }],
      'webhooks.update': [{ data: [] }],
    })
    expect(
      await verifyWebhookNow({ supabase: client, companyId: COMPANY_ID, webhookId: WEBHOOK_ID, actor, now: NOW, pinnedFetchImpl: fetch }),
    ).toMatchObject({ kind: 'cooldown' })
    // Compare-and-set on the exact value read.
    expect(filterValue(calls.find((c) => c.op === 'update')!, 'eq', 'verification_last_attempt_at')).toBe(lastAttempt)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('verifies on a correct echo and attributes the audit row to the API key', async () => {
    const { client, calls } = makeSupabase({
      'webhooks.select': [{ data: row() }],
      'webhooks.update': [{ data: [{ id: WEBHOOK_ID }] }],
    })
    expect(
      await verifyWebhookNow({
        supabase: client,
        companyId: COMPANY_ID,
        webhookId: WEBHOOK_ID,
        actor,
        now: NOW,
        pinnedFetchImpl: echoingReceiver(),
      }),
    ).toEqual({ kind: 'verified' })
    expect(filterValue(calls.find((c) => c.op === 'update')!, 'is', 'verification_last_attempt_at')).toBeNull()
    expect(calls.find((c) => c.table === 'audit_log')!.payload).toMatchObject({
      user_id: 'user-1',
      actor_id: 'ak_1',
      actor_type: 'api_key',
    })
  })

  it('returns the failure reason on a wrong answer', async () => {
    const { client } = makeSupabase({
      'webhooks.select': [{ data: row() }],
      'webhooks.update': [{ data: [{ id: WEBHOOK_ID }] }],
    })
    expect(
      await verifyWebhookNow({
        supabase: client,
        companyId: COMPANY_ID,
        webhookId: WEBHOOK_ID,
        actor,
        now: NOW,
        pinnedFetchImpl: vi.fn(async () => ok(404, 'nope')),
      }),
    ).toEqual({ kind: 'failed', reason: 'http_404', error: 'http_404' })
  })
})
