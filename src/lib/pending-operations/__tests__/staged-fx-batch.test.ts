/**
 * Approving a BATCH of staged foreign-currency bank rows.
 *
 * The report: on an instance whose exchange_rates cache is empty (no bank
 * feed fills it, and a user session cannot write it), approving 15 to 20
 * staged USD rows with different dates rejected about a third of them with
 * "ingen växelkurs kunde hämtas". Every row asked Riksbanken for its own
 * date, Riksbanken answers 429 after about five quick requests, and the
 * refusal consumed the operation, so the rows had to be staged again and
 * approved a few at a time.
 *
 * This file runs the real dispatcher and the real rate lookup against a
 * stand-in for Riksbanken that rate-limits the same way. No test reaches the
 * network: global fetch is replaced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { roundOre } from '@/lib/money'
import type { PendingOperation } from '@/types'

import { commitPendingOperation } from '../commit'
import { resetExchangeRateStateForTests } from '@/lib/currency/riksbanken'

const DAY_MS = 86_400_000

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

interface SeriesDay {
  date: string
  value: number
}

/** Banking days (Monday to Friday) with a rate that drifts a little per day. */
function publishedDays(base: number): SeriesDay[] {
  const days: SeriesDay[] = []
  for (let day = '2024-12-01'; day <= '2026-01-31'; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const ordinal = Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS) % 1000
    days.push({ date: day, value: Math.round(base * (1 + ordinal * 0.0001) * 100000) / 100000 })
  }
  return days
}

const SERIES: Record<string, SeriesDay[]> = {
  USD: publishedDays(10),
  PLN: publishedDays(2.5),
  JPY: publishedDays(0.06),
}

function expectedFor(currency: string, date: string): SeriesDay {
  const earliest = addDays(date, -7)
  const candidates = SERIES[currency].filter((d) => d.date <= date && d.date >= earliest)
  return candidates[candidates.length - 1]
}

/**
 * Riksbanken's observations endpoint with its per-IP limit: `allowed`
 * requests are answered, every later one gets 429 "Rate limit is exceeded"
 * with the wait the real limiter asks for. Answers a single day and a range
 * alike, so it serves whatever shape the lookup sends.
 */
function stubRiksbanken(limit: { allowed: number }) {
  const requests: string[] = []
  let served = 0
  vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    requests.push(url)
    if (served >= limit.allowed) {
      return new Response('Rate limit is exceeded', { status: 429, headers: { 'retry-after': '54' } })
    }
    served++
    const match = url.match(/\/Observations\/SEK([A-Z]{3})PMI\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/)
    if (!match) return new Response('Not Found', { status: 404 })
    const [, currency, from, to] = match
    const days = (SERIES[currency] ?? []).filter((d) => d.date >= from && d.date <= to)
    return days.length > 0
      ? new Response(JSON.stringify(days), { status: 200 })
      : new Response(null, { status: 204 })
  })
  return { requests }
}

/**
 * A user-session client on an instance without a bank feed: exchange_rates is
 * empty and readable, an insert into it is refused by RLS, everything else
 * the create_transaction executor touches succeeds. Records what was written.
 */
function userSessionSupabase() {
  const inserts: Record<string, Array<Record<string, unknown>>> = {}
  const operationUpdates: Array<Record<string, unknown>> = []
  let transactionSeq = 0

  const from = vi.fn((table: string) => {
    let write: 'insert' | 'update' | 'upsert' | null = null
    const result = () => {
      if (table === 'pending_operations') return { data: { id: 'claimed' }, error: null }
      if (table === 'transactions' && write === 'insert') {
        return { data: { id: `tx-${++transactionSeq}` }, error: null }
      }
      if (table === 'exchange_rates' && write !== null) {
        return { data: null, error: { code: '42501', message: 'permission denied for table exchange_rates' } }
      }
      return { data: null, error: null }
    }
    const chain: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result())
          if (prop === 'insert' || prop === 'update' || prop === 'upsert') {
            return (payload: Record<string, unknown>) => {
              write = prop
              if (prop === 'insert') (inserts[table] ??= []).push(payload)
              if (prop === 'update' && table === 'pending_operations') operationUpdates.push(payload)
              return chain
            }
          }
          return () => chain
        },
      },
    )
    return chain
  })

  return { supabase: { from, rpc: vi.fn() } as never, inserts, operationUpdates }
}

function stagedRow(n: number, date: string, currency: string, amount: number): PendingOperation {
  return {
    id: `op-${n}`,
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_transaction',
    status: 'pending',
    title: 'test',
    params: { date, amount, description: `Row ${n}`, currency },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2025-11-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2025-11-01T00:00:00Z',
  }
}

/** 18 USD rows, one every 17 days through 2025: weekends among them. */
const BATCH = Array.from({ length: 18 }, (_, i) =>
  stagedRow(i + 1, addDays('2025-01-04', i * 17), 'USD', -(100 + i * 7.5)),
)

/** What the bulk-approve route does: one operation after the other, same client. */
async function approveAll(supabase: never, operations: PendingOperation[]) {
  const results = []
  for (const operation of operations) {
    results.push(await commitPendingOperation(supabase, 'user-1', 'company-1', operation))
  }
  return results
}

beforeEach(() => {
  vi.restoreAllMocks()
  eventBus.clear()
  resetExchangeRateStateForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('approving a batch of staged foreign-currency bank rows', () => {
  it('commits all 18 rows on an empty cache with ONE Riksbanken request', async () => {
    // Five requests is what Riksbanken allows in quick succession; one per
    // row tripped the limit after a handful of rows.
    const riksbanken = stubRiksbanken({ allowed: 5 })
    const { supabase, inserts, operationUpdates } = userSessionSupabase()

    const results = await approveAll(supabase, BATCH)

    expect(results.map((r) => r.status)).toEqual(BATCH.map(() => 'committed'))
    expect(riksbanken.requests).toHaveLength(1)
    expect(operationUpdates.filter((u) => u.status === 'rejected')).toEqual([])

    expect(inserts['transactions']).toHaveLength(18)
    for (let i = 0; i < BATCH.length; i++) {
      const { date, amount } = BATCH[i].params as { date: string; amount: number }
      const expected = expectedFor('USD', date)
      // Each row at the rate of its OWN date (the latest earlier observation
      // for a weekend), never one rate for the batch and never 1:1.
      expect(inserts['transactions'][i], date).toMatchObject({
        date,
        amount,
        currency: 'USD',
        exchange_rate: expected.value,
        exchange_rate_date: expected.date,
        amount_sek: roundOre(amount * expected.value),
      })
      expect(inserts['transactions'][i].amount_sek).not.toBe(amount)
    }
  })

  it('hands every row back to pending when Riksbanken rate-limits, and the same approvals work after the wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const limit = { allowed: 0 }
    const riksbanken = stubRiksbanken(limit)
    const { supabase, inserts, operationUpdates } = userSessionSupabase()
    const rows = BATCH.slice(0, 6)

    const refused = await approveAll(supabase, rows)

    for (const result of refused) {
      expect(result.status).toBe('failed')
      expect(result.code).toBe('FX_RATE_TEMPORARILY_UNAVAILABLE')
      expect(result.http_status).toBe(503)
      // Not consumed: the operation is still there to approve.
      expect(result.operation_status).toBe('pending')
      expect(result.error).toMatch(/Riksbanken/)
      expect(result.error).toMatch(/ligger kvar/)
    }
    // Claimed, then released: never rejected, and nothing was written.
    expect(operationUpdates.map((u) => u.status)).toEqual(rows.flatMap(() => ['committing', 'pending']))
    expect(inserts['transactions']).toBeUndefined()
    // One refused request for the whole batch: the other five rows did not
    // ask again, and none of them waited.
    expect(riksbanken.requests).toHaveLength(1)

    // A minute later Riksbanken answers again. No re-staging: the same
    // operations are approved once more.
    vi.setSystemTime(Date.now() + 55_000)
    limit.allowed = 5
    operationUpdates.length = 0

    const approved = await approveAll(supabase, rows)

    expect(approved.map((r) => r.status)).toEqual(rows.map(() => 'committed'))
    expect(inserts['transactions']).toHaveLength(6)
    expect(riksbanken.requests).toHaveLength(2)
  })

  it('still refuses a row whose rate does not exist, and never books it at 1:1', async () => {
    // A date Riksbanken has no observation near: nothing to wait for.
    const riksbanken = stubRiksbanken({ allowed: 5 })
    const { supabase, inserts, operationUpdates } = userSessionSupabase()

    const [result] = await approveAll(supabase, [stagedRow(1, '2030-06-03', 'USD', 1500)])

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.code).toBeUndefined()
    expect(result.error).toMatch(/ingen växelkurs/)
    expect(result.error).toMatch(/1 USD = 1 SEK/)
    expect(result.operation_status).toBe('rejected')
    expect(operationUpdates.map((u) => u.status)).toEqual(['committing', 'rejected'])
    expect(inserts['transactions']).toBeUndefined()
    expect(riksbanken.requests).toHaveLength(1)
  })

  it('refuses a currency Riksbanken has no series for without asking', async () => {
    const riksbanken = stubRiksbanken({ allowed: 5 })
    const { supabase, inserts } = userSessionSupabase()

    const [result] = await approveAll(supabase, [stagedRow(1, '2025-03-14', 'XXX', 1500)])

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.operation_status).toBe('rejected')
    expect(inserts['transactions']).toBeUndefined()
    expect(riksbanken.requests).toEqual([])
  })

  it('commits rows in currencies outside the invoicing set that Riksbanken publishes', async () => {
    // A multi-currency account holds balances in currencies the app cannot
    // invoice in. The rate exists, so the row gets its SEK value.
    const riksbanken = stubRiksbanken({ allowed: 5 })
    const { supabase, inserts } = userSessionSupabase()

    const results = await approveAll(supabase, [
      stagedRow(1, '2025-03-14', 'PLN', 400),
      stagedRow(2, '2025-03-17', 'PLN', -120.5),
      stagedRow(3, '2025-03-14', 'JPY', 150000),
    ])

    expect(results.map((r) => r.status)).toEqual(['committed', 'committed', 'committed'])
    expect(riksbanken.requests).toHaveLength(2)
    expect(riksbanken.requests[0]).toContain('/SEKPLNPMI/')
    expect(riksbanken.requests[1]).toContain('/SEKJPYPMI/')
    const pln = expectedFor('PLN', '2025-03-14')
    const jpy = expectedFor('JPY', '2025-03-14')
    expect(inserts['transactions'][0]).toMatchObject({
      currency: 'PLN',
      exchange_rate: pln.value,
      amount_sek: roundOre(400 * pln.value),
    })
    // Quoted per ONE yen: 150 000 JPY is about 9 000 kr, not 900 000.
    expect(inserts['transactions'][2]).toMatchObject({
      currency: 'JPY',
      exchange_rate: jpy.value,
      amount_sek: roundOre(150000 * jpy.value),
    })
    expect(inserts['transactions'][2].amount_sek as number).toBeLessThan(15000)
  })
})
