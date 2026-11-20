import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * The daily TIC budget read: cron-authenticated, skipped when the TIC
 * extension is off, answers our counters next to TIC's own, and raises an
 * alert when the quota runs low or TIC counts calls the budget never saw.
 */

const mocks = vi.hoisted(() => ({
  verifyCronSecret: vi.fn(),
  registryGet: vi.fn(),
  readTicBudgetStatus: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: mocks.verifyCronSecret }))
// The real client needs a native WebSocket, which Node 20 (CI) lacks.
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (...args: unknown[]) => mocks.registryGet(...args) },
}))
vi.mock('@/lib/tic-budget/status', () => ({ readTicBudgetStatus: mocks.readTicBudgetStatus }))
vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: mocks.warn, error: vi.fn(), child: () => logger }
  return { createLogger: () => logger }
})

import { GET } from '../route'
import { createCronRequest, parseJsonResponse } from '@/tests/helpers'

const PATH = '/api/extensions/tic/budget/cron'

function status(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    cycleStart: '2026-10-22',
    caps: {},
    local: { total: 700, byPurpose: {} },
    upstream: { rateLimit: 3000, rateLimitRemaining: 2300, rateLimitReset: null },
    unattributed: 0,
    ...overrides,
  }
}

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  mocks.verifyCronSecret.mockReturnValue(null)
  mocks.registryGet.mockResolvedValue({ id: 'tic' })
  mocks.readTicBudgetStatus.mockResolvedValue(status())
})

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey
})

describe('GET /api/extensions/tic/budget/cron', () => {
  it('refuses a request without the cron secret', async () => {
    mocks.verifyCronSecret.mockReturnValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await GET(createCronRequest(PATH))
    expect(res.status).toBe(401)
    expect(mocks.readTicBudgetStatus).not.toHaveBeenCalled()
  })

  it('skips when the TIC extension is not enabled', async () => {
    mocks.registryGet.mockResolvedValue(undefined)
    const { status: code, body } = await parseJsonResponse<{ skipped: boolean }>(await GET(createCronRequest(PATH)))
    expect(code).toBe(200)
    expect(body.skipped).toBe(true)
    expect(mocks.readTicBudgetStatus).not.toHaveBeenCalled()
  })

  it('answers the status and raises no alert when healthy', async () => {
    const { status: code, body } = await parseJsonResponse<{ cycleStart: string; unattributed: number }>(
      await GET(createCronRequest(PATH)),
    )
    expect(code).toBe(200)
    expect(body).toMatchObject({ cycleStart: '2026-10-22', unattributed: 0 })
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ alert: true }))
  })

  it('alerts on a low quota and on calls the budget did not count', async () => {
    mocks.readTicBudgetStatus.mockResolvedValue(
      status({ upstream: { rateLimit: 3000, rateLimitRemaining: 120, rateLimitReset: null }, unattributed: 2100 }),
    )
    await GET(createCronRequest(PATH))
    expect(mocks.warn).toHaveBeenCalledWith('tic quota low', expect.objectContaining({ alert: true, remaining: 120 }))
    expect(mocks.warn).toHaveBeenCalledWith(
      'tic calls not counted by the budget',
      expect.objectContaining({ alert: true, unattributed: 2100 }),
    )
  })
})
