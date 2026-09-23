/**
 * Tests for the per-minute webhook dispatch cron (#1257).
 *
 * The route is a thin wrapper, so there is exactly one thing here that is not
 * covered by lib/webhooks/__tests__: the function budget. The dispatcher's
 * CYCLE_BUDGET_MS is what hands unattempted claims back before a cycle ends,
 * and the 160 s stuck-recovery window is derived from it. Both are only real
 * if the platform grants the invocation more wall time than the budget spends,
 * which is what `export const maxDuration` buys. Without it the route runs on
 * the platform default, the release path can be killed before it fires, and
 * rows stay stranded in in_flight carrying their claim-time updated_at.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/cron'
import { __TESTING__ } from '@/lib/webhooks/dispatcher'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ __client: true })),
}))

const dispatchDueDeliveries = vi.fn()
vi.mock('@/lib/webhooks/dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/webhooks/dispatcher')>()
  return {
    ...actual,
    dispatchDueDeliveries: (...args: unknown[]) => dispatchDueDeliveries(...args),
  }
})

import { GET, maxDuration } from '../route'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/webhooks/dispatch/cron')
}

const SUMMARY = {
  picked: 3,
  delivered: 1,
  failed: 1,
  dead: 1,
  skipped: 0,
  released: 0,
  recovered: 2,
  recoveredDead: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  dispatchDueDeliveries.mockResolvedValue(SUMMARY)
})

describe('GET /api/webhooks/dispatch/cron', () => {
  it('declares a function budget above the dispatcher cycle budget', () => {
    expect(maxDuration).toBe(300)
    // The load-bearing relation, not just the literal: the in-code budget can
    // only hand claims back if the invocation is still alive when it expires.
    expect(maxDuration * 1000).toBeGreaterThan(__TESTING__.CYCLE_BUDGET_MS)
    // And the sweep window has to fit inside the invocation too, otherwise the
    // window is derived from a bound nothing enforces.
    expect(maxDuration * 1000).toBeGreaterThan(
      __TESTING__.CYCLE_BUDGET_MS +
        __TESTING__.REQUEST_TIMEOUT_MS +
        __TESTING__.STUCK_RECOVERY_SLACK_MS,
    )
  })

  it('returns 401 and dispatches nothing when the cron secret is invalid', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(dispatchDueDeliveries).not.toHaveBeenCalled()
  })

  it('returns the full dispatch summary, including the sweep outcome', async () => {
    const response = await GET(cronRequest())
    expect(response.status).toBe(200)

    const body = (await response.json()) as { data: typeof SUMMARY }
    // recovered / recoveredDead are the counts an operator needs to see that a
    // tick took deliveries to the terminal, immutable 'dead' state.
    expect(body.data).toEqual(SUMMARY)
    expect(dispatchDueDeliveries).toHaveBeenCalledTimes(1)
  })
})
