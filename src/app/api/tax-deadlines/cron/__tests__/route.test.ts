import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return {
    createClient: vi.fn(() => ({ kind: 'service-client' })),
    annual: vi.fn(),
    backfill: vi.fn(),
    euTrade: vi.fn(),
    log,
  }
})

// log.error is what reaches the error tracker: the run-out-of-time report is asserted on it.
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  createLogger: () => mocks.log,
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
  alignYearlyVatDeadlinesWithBooks: mocks.euTrade,
}))

import { verifyCronSecret } from '@/lib/auth/cron'
import { GET } from '../route'
import { createCronRequest } from '@/tests/helpers'

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  mocks.log.child.mockReturnValue(mocks.log)
  mocks.annual.mockResolvedValue({ usersProcessed: 0, totalCreated: 0, companiesNotReached: 0 })
  mocks.backfill.mockResolvedValue({
    companiesScanned: 10,
    companiesRepaired: 2,
    totalCreated: 24,
    companiesNotReached: 0,
  })
  mocks.euTrade.mockResolvedValue({ companiesChecked: 5, companiesMoved: 1, companiesNotReached: 0 })
})

afterEach(() => {
  vi.useRealTimers()
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey
})

describe('GET /api/tax-deadlines/cron', () => {
  it('repairs companies with missing deadlines on the daily run', async () => {
    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))

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
    expect(mocks.log.error).not.toHaveBeenCalled()
  })

  it('gives the repair a deadline 240 s after the run began, inside the 300 s limit', async () => {
    const startedAt = Date.now()

    await GET(createCronRequest('/api/tax-deadlines/cron'))

    expect(mocks.backfill).toHaveBeenCalledWith(expect.anything(), { deadline: startedAt + 240_000 })
  })

  it('moves helårsmoms rows the books date earlier after the repair, in at most 60 s of the run', async () => {
    const startedAt = Date.now()
    const order: string[] = []
    mocks.backfill.mockImplementation(async () => {
      order.push('repair')
      // The repair takes 30 s: the pass's minute starts when it does.
      vi.advanceTimersByTime(30_000)
      return { companiesScanned: 10, companiesRepaired: 2, totalCreated: 24, companiesNotReached: 0 }
    })
    mocks.euTrade.mockImplementation(async () => {
      order.push('eu-trade')
      return { companiesChecked: 5, companiesMoved: 1, companiesNotReached: 0 }
    })

    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))

    expect(order).toEqual(['repair', 'eu-trade'])
    expect(mocks.euTrade).toHaveBeenCalledWith(expect.anything(), { deadline: startedAt + 90_000 })
    await expect(response.json()).resolves.toMatchObject({
      euTradeCompaniesChecked: 5,
      euTradeCompaniesMoved: 1,
      euTradeCompaniesNotReached: 0,
    })
  })

  it('a failed pass is logged and the run still answers what the repair did', async () => {
    mocks.euTrade.mockRejectedValue(new Error('statement timeout'))

    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, companiesRepaired: 2, euTradeCompaniesMoved: 0 })
    expect(mocks.log.error).toHaveBeenCalledWith('helårsmoms EU-trade pass failed', expect.any(Error))
  })

  it('reports the companies a run did not reach as an error, and still answers what it did', async () => {
    mocks.backfill.mockResolvedValue({
      companiesScanned: 400,
      companiesRepaired: 310,
      totalCreated: 3100,
      companiesNotReached: 90,
    })

    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      companiesRepaired: 310,
      companiesNotReached: 90,
    })
    expect(mocks.log.error).toHaveBeenCalledTimes(1)
    expect(mocks.log.error).toHaveBeenCalledWith(
      expect.stringContaining('stopped at its time budget'),
      expect.any(Error),
      expect.objectContaining({ companiesNotReached: 90, companiesRepaired: 310 }),
    )
  })

  it('extends every company horizon before running recovery on January 2', async () => {
    vi.setSystemTime(new Date('2027-01-02T00:00:00.000Z'))
    mocks.annual.mockResolvedValue({ usersProcessed: 8, totalCreated: 80, companiesNotReached: 0 })
    const startedAt = Date.now()

    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))
    const body = await response.json()

    // Both passes share the one deadline of the run.
    expect(mocks.annual).toHaveBeenCalledWith(expect.anything(), { deadline: startedAt + 240_000 })
    expect(mocks.backfill).toHaveBeenCalledWith(expect.anything(), { deadline: startedAt + 240_000 })

    expect(body).toMatchObject({
      isAnnualRun: true,
      usersProcessed: 8,
      totalCreated: 104,
    })
    expect(mocks.annual).toHaveBeenCalledOnce()
    expect(mocks.backfill).toHaveBeenCalledOnce()
  })

  it.each([
    ['the Swedish 2 January, still the 1st in UTC', '2027-01-01T23:30:00.000Z', true],
    ['the Swedish 3 January, still the 2nd in UTC', '2027-01-02T23:30:00.000Z', false],
  ])('on %s the annual run follows the Swedish day', async (_when, instant, isAnnualRun) => {
    vi.setSystemTime(new Date(instant))

    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))

    await expect(response.json()).resolves.toMatchObject({ isAnnualRun })
  })

  it('returns 401 without creating a database client when cron auth fails', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(createCronRequest('/api/tax-deadlines/cron'))

    expect(response.status).toBe(401)
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.backfill).not.toHaveBeenCalled()
  })
})
