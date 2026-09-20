import { describe, expect, it, vi } from 'vitest'
import { AspspUnavailableError, ConnectorSyncError } from '../api-client'
import {
  DAILY_QUOTA_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  applyRateLimitCooldown,
  claimSyncLease,
  holdSyncLease,
  rateLimitCooldownMs,
} from '../sync-lease'
import { SYNC_COOLDOWN_MS } from '@/lib/bank-sync/trigger-sync-contract'

const NOW = Date.parse('2026-09-02T05:00:00.000Z')

/** Records the one query a lease helper issues and answers it with `rows`. */
function recordingClient(rows: { id: string }[] = [], error: unknown = null) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain: Record<string, unknown> = {}
  for (const method of ['update', 'eq', 'lte', 'lt', 'select']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    })
  }
  chain.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error }).then(onFulfilled)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: () => chain } as any, calls }
}

const rateLimited = (rateLimit: { dailyQuota: boolean; retryAfterSeconds?: number }) =>
  new AspspUnavailableError(429, 'Too Many Requests', 'rate-limited', undefined, rateLimit)

describe('claimSyncLease', () => {
  it('claims with one conditional update and reports the win', async () => {
    const { client, calls } = recordingClient([{ id: 'conn-1' }])

    await expect(claimSyncLease(client, 'conn-1', NOW)).resolves.toBe(true)

    expect(calls).toEqual([
      { method: 'update', args: [{ sync_lease_until: new Date(NOW + SYNC_COOLDOWN_MS).toISOString() }] },
      { method: 'eq', args: ['id', 'conn-1'] },
      { method: 'lte', args: ['sync_lease_until', new Date(NOW).toISOString()] },
      { method: 'select', args: ['id'] },
    ])
  })

  it('reports a loss when the lease is held', async () => {
    const { client } = recordingClient([])

    await expect(claimSyncLease(client, 'conn-1', NOW)).resolves.toBe(false)
  })
})

describe('holdSyncLease', () => {
  it('only ever extends, and covers the whole session when given one', async () => {
    const { client, calls } = recordingClient()
    const until = NOW + DAILY_QUOTA_COOLDOWN_MS

    await holdSyncLease(client, { connectionId: 'conn-1', sessionId: 'sess-1' }, until)

    expect(calls.slice(1)).toEqual([
      { method: 'eq', args: ['session_id', 'sess-1'] },
      { method: 'lt', args: ['sync_lease_until', new Date(until).toISOString()] },
    ])
  })

  it('falls back to the one connection without a session', async () => {
    const { client, calls } = recordingClient()

    await holdSyncLease(client, { connectionId: 'conn-1', sessionId: null }, NOW)

    expect(calls[1]).toEqual({ method: 'eq', args: ['id', 'conn-1'] })
  })
})

describe('rateLimitCooldownMs', () => {
  it('sits out a daily quota for hours', () => {
    expect(rateLimitCooldownMs(rateLimited({ dailyQuota: true }))).toBe(DAILY_QUOTA_COOLDOWN_MS)
  })

  it('sits out at least the next hourly run on a burst limit', () => {
    expect(rateLimitCooldownMs(rateLimited({ dailyQuota: false, retryAfterSeconds: 30 }))).toBe(
      RATE_LIMIT_COOLDOWN_MS,
    )
  })

  it('honours a longer Retry-After, capped at the daily cooldown', () => {
    expect(rateLimitCooldownMs(rateLimited({ dailyQuota: false, retryAfterSeconds: 2 * 3600 }))).toBe(
      2 * 3600 * 1000,
    )
    expect(rateLimitCooldownMs(rateLimited({ dailyQuota: false, retryAfterSeconds: 99 * 3600 }))).toBe(
      DAILY_QUOTA_COOLDOWN_MS,
    )
  })

  it('treats a 429 from the connector hop the same way', () => {
    expect(rateLimitCooldownMs(new ConnectorSyncError(429, 'HTTP_429', ''))).toBe(RATE_LIMIT_COOLDOWN_MS)
  })

  it('is null for every other failure', () => {
    expect(rateLimitCooldownMs(new Error('ASPSP 500'))).toBeNull()
    expect(rateLimitCooldownMs(new AspspUnavailableError(400, '', 'ladder-exhausted', undefined))).toBeNull()
    expect(rateLimitCooldownMs(new ConnectorSyncError(null, 'CONNECTOR_TIMEOUT', ''))).toBeNull()
  })
})

describe('applyRateLimitCooldown', () => {
  it('does not touch the database for a failure that is not a rate limit', async () => {
    const { client, calls } = recordingClient()

    await expect(applyRateLimitCooldown(client, { id: 'conn-1' }, new Error('boom'), NOW)).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it('never throws on top of the failure being handled', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = recordingClient([], { message: 'db down' })

    await expect(
      applyRateLimitCooldown(client, { id: 'conn-1', session_id: 'sess-1' }, rateLimited({ dailyQuota: true }), NOW),
    ).resolves.toBe(DAILY_QUOTA_COOLDOWN_MS)
    consoleError.mockRestore()
  })
})
