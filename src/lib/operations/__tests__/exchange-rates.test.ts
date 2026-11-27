/**
 * The exchange-rate read (../exchange-rates.ts): Riksbanken's own
 * observation for the day or the latest earlier one with its date, a typed
 * reason instead of a number when there is none, and nothing for a day
 * after today. Global fetch stands in for Riksbanken; nothing reaches the
 * network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return { createLogger: () => log }
})

import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { resetExchangeRateStateForTests } from '@/lib/currency/riksbanken'
import { createLogger } from '@/lib/logger'
import { exchangeRatesGet } from '../exchange-rates'
import { ALL_OPERATIONS } from '../registry'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

function ctx(settings: Record<string, unknown> | null = null) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: settings }) // company_settings: the sandbox guard
  return { supabase: supabase as never, companyId: COMPANY_ID, userId: USER_ID, log: createLogger('test') }
}

const fetchMock = vi.fn()

beforeEach(() => {
  resetExchangeRateStateForTests()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  // Friday 27 November 2026, 10:00 in Stockholm.
  vi.setSystemTime(new Date('2026-11-27T09:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const observations = (days: Array<[string, number]>) =>
  new Response(JSON.stringify(days.map(([date, value]) => ({ date, value }))), { status: 200 })

describe('exchange-rates.get', () => {
  it("answers a Saturday with Friday's observation and says which day it is from", async () => {
    fetchMock.mockResolvedValue(
      observations([
        ['2026-10-29', 11.0412],
        ['2026-10-30', 11.0425],
        ['2026-11-02', 11.0611],
      ]),
    )
    const outcome = await exchangeRatesGet.run(ctx(), { currency: 'EUR', date: '2026-10-31' }, { dryRun: false })
    expect(outcome).toEqual({
      ok: true,
      data: {
        currency: 'EUR',
        date: '2026-10-31',
        available: true,
        rate: 11.0425,
        observation_date: '2026-10-30',
        reason: null,
        source: 'riksbanken',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/Observations/SEKEURPMI/')
  })

  it('reads today in Sweden when no date is given', async () => {
    fetchMock.mockResolvedValue(observations([['2026-11-26', 10.9888]]))
    const outcome = await exchangeRatesGet.run(ctx(), { currency: 'USD' }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      data: { currency: 'USD', date: '2026-11-27', available: true, rate: 10.9888, observation_date: '2026-11-26' },
    })
  })

  it('refuses a day after today without asking Riksbanken', async () => {
    const outcome = await exchangeRatesGet.run(ctx(), { currency: 'EUR', date: '2026-11-28' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'date' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never asks Riksbanken for a sandbox company, as the app\'s own rate route does not', async () => {
    const outcome = await exchangeRatesGet.run(ctx({ is_sandbox: true }), { currency: 'EUR', date: '2026-10-31' }, { dryRun: false })
    expect(outcome).toEqual({ ok: false, code: 'EXCHANGE_RATE_SANDBOX' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says Riksbanken refused for the moment instead of giving a number', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
    const outcome = await exchangeRatesGet.run(ctx(), { currency: 'EUR', date: '2026-11-20' }, { dryRun: false })
    expect(outcome).toEqual({
      ok: true,
      data: {
        currency: 'EUR',
        date: '2026-11-20',
        available: false,
        rate: null,
        observation_date: null,
        reason: 'temporarily_unavailable',
        source: 'riksbanken',
      },
    })
  })

  it('says there is no rate when Riksbanken has no observation within the look-back', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const outcome = await exchangeRatesGet.run(ctx(), { currency: 'RUB', date: '2026-11-20' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { available: false, rate: null, reason: 'no_rate' } })
  })

  it('takes only currencies Riksbanken publishes a SEK rate for, and a real date', () => {
    expect(exchangeRatesGet.input.safeParse({ currency: 'EUR', date: '2026-10-31' }).success).toBe(true)
    expect(exchangeRatesGet.input.safeParse({ currency: 'SEK' }).success).toBe(false)
    expect(exchangeRatesGet.input.safeParse({ currency: 'ALL' }).success).toBe(false)
    expect(exchangeRatesGet.input.safeParse({ currency: 'EUR', date: '2026-02-30' }).success).toBe(false)
  })

  it('is a read in the registry, an MCP tool under reports:read', () => {
    expect(ALL_OPERATIONS).toContain(exchangeRatesGet)
    expect(exchangeRatesGet.kind).toBe('read')
    expect(exchangeRatesGet.mcp?.name).toBe('gnubok_get_exchange_rate')
    expect(TOOL_SCOPE_MAP.gnubok_get_exchange_rate).toBe('reports:read')
  })
})
