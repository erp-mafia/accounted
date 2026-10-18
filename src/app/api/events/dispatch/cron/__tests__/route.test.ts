/**
 * GET /api/events/dispatch/cron: the event outbox dispatcher's cron door.
 * Cron secret first; with EVENT_OUTBOX_MODE off it answers at once without a
 * database client; in shadow it runs one dispatch cycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { verifyCronSecret } from '@/lib/auth/cron'
import { DISPATCH_BUDGET_MS } from '@/lib/events/outbox-dispatcher'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ __client: true })),
}))

const dispatchEventOutbox = vi.fn()
vi.mock('@/lib/events/outbox-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/events/outbox-dispatcher')>()
  return { ...actual, dispatchEventOutbox: (...args: unknown[]) => dispatchEventOutbox(...args) }
})

import { GET, maxDuration } from '../route'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createCronRequest, parseJsonResponse } from '@/tests/helpers'

const SUMMARY = {
  mode: 'shadow',
  batches: 2,
  claimed: 230,
  completed: 229,
  ran: 12,
  retried: 1,
  dead: 0,
  oldestAgeMs: 41_000,
  notDeployed: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  dispatchEventOutbox.mockResolvedValue(SUMMARY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/events/dispatch/cron', () => {
  it('answers 401 without the cron secret and touches nothing', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await GET(createCronRequest('/api/events/dispatch/cron'))
    expect(response.status).toBe(401)
    expect(dispatchEventOutbox).not.toHaveBeenCalled()
  })

  it.each([undefined, 'off'])('returns at once with EVENT_OUTBOX_MODE %s: no client, no dispatch', async (mode) => {
    vi.stubEnv('EVENT_OUTBOX_MODE', mode)
    const { status, body } = await parseJsonResponse(await GET(createCronRequest('/api/events/dispatch/cron')))
    expect(status).toBe(200)
    expect(body).toEqual({ data: { mode: 'off', skipped: true } })
    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
    expect(dispatchEventOutbox).not.toHaveBeenCalled()
  })

  it('runs one dispatch cycle in shadow mode and answers its summary', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    const { status, body } = await parseJsonResponse(await GET(createCronRequest('/api/events/dispatch/cron')))
    expect(status).toBe(200)
    expect(body).toEqual({ data: SUMMARY })
    expect(dispatchEventOutbox).toHaveBeenCalledWith({ supabase: { __client: true } })
  })

  it('declares a function budget above the dispatcher cycle budget', () => {
    expect(maxDuration * 1000).toBeGreaterThan(DISPATCH_BUDGET_MS)
  })
})
