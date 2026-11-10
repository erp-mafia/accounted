/**
 * The shared exchange_rates cache heals a row stored before its date was
 * published (crm#1740), against real Postgres: the service-role writer
 * replaces the row in place (INSERT ... ON CONFLICT DO UPDATE needs UPDATE on
 * the table for service_role), while a settled weekend or holiday row is
 * served as stored.
 *
 * What is not real: Riksbanken (global fetch is stubbed) and the HTTP hop to
 * PostgREST, replaced by tests/pg/postgrest-over-pg.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  fetchExchangeRate,
  resetExchangeRateStateForTests,
  setExchangeRateCacheWriterForTests,
} from '@/lib/currency/riksbanken'
import { createPgRest } from './postgrest-over-pg'
import { getPool } from './setup'

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

const rest = createPgRest({ role: 'service_role' })
const service = createClient('http://pg-real.invalid', 'pg-real-service-role', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: rest.fetch },
  realtime: { transport: UnusedRealtimeTransport as never },
})

// A currency and year no other pg suite seeds, so the rows are this file's own.
const CURRENCY = 'NZD'

/** Riksbanken's range endpoint, publishing exactly these observations. */
function stubRiksbanken(observations: Array<{ date: string; value: number }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (!url.startsWith('https://api.riksbank.se/')) throw new Error(`unexpected request ${url}`)
    return new Response(JSON.stringify(observations), { status: 200 })
  })
}

async function seedRow(rateDate: string, rate: number, observationDate: string, fetchedAt: string) {
  await getPool().query(
    `INSERT INTO public.exchange_rates (currency, rate_date, rate, observation_date, source, fetched_at)
     VALUES ($1, $2, $3, $4, 'riksbanken', $5)`,
    [CURRENCY, rateDate, rate, observationDate, fetchedAt],
  )
}

async function storedRow(rateDate: string) {
  const { rows } = await getPool().query<{ rate: string; observation_date: string; fetched_at: Date }>(
    `SELECT rate::text, observation_date::text, fetched_at FROM public.exchange_rates
      WHERE currency = $1 AND rate_date = $2`,
    [CURRENCY, rateDate],
  )
  return rows
}

async function clearRows() {
  await getPool().query(`DELETE FROM public.exchange_rates WHERE currency = $1 AND rate_date BETWEEN '2025-01-01' AND '2025-12-31'`, [
    CURRENCY,
  ])
}

beforeEach(async () => {
  resetExchangeRateStateForTests()
  setExchangeRateCacheWriterForTests(service as never)
  await clearRows()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetExchangeRateStateForTests()
  expect(rest.unsupported.splice(0)).toEqual([])
})

afterAll(async () => {
  await clearRows()
})

describe('exchange_rates: a row stored before its date was published.pg', () => {
  it('is looked up again and replaced in place with the date\'s own observation', async () => {
    // Thursday's row, stored on Thursday morning with Wednesday's rate.
    await seedRow('2025-09-04', 9.99, '2025-09-03', '2025-09-04T03:00:00Z')
    const riksbanken = stubRiksbanken([
      { date: '2025-09-03', value: 9.99 },
      { date: '2025-09-04', value: 10.01 },
    ])

    const result = await fetchExchangeRate(CURRENCY, new Date('2025-09-04'), service as never)

    expect(result).toEqual({ currency: CURRENCY, rate: 10.01, date: '2025-09-04' })
    expect(riksbanken).toHaveBeenCalledTimes(1)
    const rows = await storedRow('2025-09-04')
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]!.rate)).toBe(10.01)
    expect(rows[0]!.observation_date).toBe('2025-09-04')
    expect(rows[0]!.fetched_at.getTime()).toBeGreaterThan(Date.parse('2025-09-05T00:00:00Z'))

    // From now on the cache answers without Riksbanken.
    resetExchangeRateStateForTests()
    setExchangeRateCacheWriterForTests(service as never)
    riksbanken.mockClear()
    expect(await fetchExchangeRate(CURRENCY, new Date('2025-09-04'), service as never)).toEqual(result)
    expect(riksbanken).not.toHaveBeenCalled()
  })

  it('serves a holiday row fetched after the holiday as stored, the previous banking day\'s rate', async () => {
    await seedRow('2025-06-06', 10.37, '2025-06-05', '2025-06-09T05:00:00Z')
    const riksbanken = stubRiksbanken([])

    const result = await fetchExchangeRate(CURRENCY, new Date('2025-06-06'), service as never)

    expect(result).toEqual({ currency: CURRENCY, rate: 10.37, date: '2025-06-05' })
    expect(riksbanken).not.toHaveBeenCalled()
    const rows = await storedRow('2025-06-06')
    expect(rows[0]!.fetched_at.toISOString()).toBe('2025-06-09T05:00:00.000Z')
  })
})
