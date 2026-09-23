import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(() => ({ kind: 'service-client' })),
  annual: vi.fn(),
  backfill: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/tax/deadline-generator', () => ({
  generateNewYearDeadlines: mocks.annual,
  backfillMissingTaxDeadlines: mocks.backfill,
}))

import { verifyCronSecret } from '@/lib/auth/cron'
import { GET } from '../route'

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/tax-deadlines/cron')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  mocks.annual.mockResolvedValue({ usersProcessed: 0, totalCreated: 0 })
  mocks.backfill.mockResolvedValue({
    companiesScanned: 10,
    companiesRepaired: 2,
    totalCreated: 24,
  })
})

afterEach(() => {
  vi.useRealTimers()
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey
})

describe('GET /api/tax-deadlines/cron', () => {
  it('repairs companies with missing deadlines on the daily run', async () => {
    const response = await GET(cronRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      isAnnualRun: false,
      companiesScanned: 10,
      companiesRepaired: 2,
      totalCreated: 24,
    })
    expect(mocks.backfill).toHaveBeenCalledOnce()
    expect(mocks.annual).not.toHaveBeenCalled()
  })

  it('extends every company horizon before running recovery on January 2', async () => {
    vi.setSystemTime(new Date('2027-01-02T00:00:00.000Z'))
    mocks.annual.mockResolvedValue({ usersProcessed: 8, totalCreated: 80 })

    const response = await GET(cronRequest())
    const body = await response.json()

    expect(body).toMatchObject({
      isAnnualRun: true,
      usersProcessed: 8,
      totalCreated: 104,
    })
    expect(mocks.annual).toHaveBeenCalledOnce()
    expect(mocks.backfill).toHaveBeenCalledOnce()
  })

  it('returns 401 without creating a database client when cron auth fails', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.backfill).not.toHaveBeenCalled()
  })
})
