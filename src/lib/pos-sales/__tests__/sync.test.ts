import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PosDay, PosDayResponse } from '@accounted/connect-contract'
import { createFakeDb } from './fake-db'
import { reevaluatePosDays, syncPosConnection } from '../sync'
import { DEFAULT_POS_SALES_SETTINGS, applyPosSalesSettingsPatch } from '../settings'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never
const COMPANY = 'company-1'
const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
// 2026-10-03 08:00 Swedish time (CEST): 2026-10-02 is the latest closed day.
const NOW = new Date('2026-10-03T06:00:00Z')

function day(date: string, gross = 112): PosDay {
  const vat = Math.round((gross - gross / 1.12) * 100) / 100
  const net = Math.round((gross - vat) * 100) / 100
  return {
    businessDate: date,
    currency: 'SEK',
    sales: { net, vat, gross },
    vatGroups: [{ ratePercent: 12, net, vat, gross }],
    tenders: [{ kind: 'card', method: 'card', amount: gross, tips: 0, receiptCount: 1 }],
    tips: 0,
    discounts: 0,
    refunds: { count: 0, gross: 0 },
    receiptCount: 1,
    firstReceiptNumber: '1',
    lastReceiptNumber: '1',
    firstPaidAt: null,
    lastPaidAt: null,
    categories: [],
    receipts: [],
    issues: [],
  }
}

function response(date: string, gross = 112, sha = 'a'): PosDayResponse {
  return {
    provider: 'heynow',
    venueRef: '5550000000000001',
    day: day(date, gross),
    raw: { contentType: 'application/json', body: `{"d":"${date}","g":${gross}}`, sha256: sha.repeat(64).slice(0, 64) },
    fetchedAt: NOW.toISOString(),
  }
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: COMPANY,
    provider: 'heynow',
    provider_name: 'Heynow',
    route: 'connect',
    venue_ref: '5550000000000001',
    venue_name: 'Restaurang Exempel',
    connection_handle: 'pos_handle_abcdefghijklmnop',
    status: 'active',
    health: 'ok',
    health_code: null,
    sync_from: '2026-09-30',
    synced_through: null,
    next_run_at: NOW.toISOString(),
    lease_until: new Date(0).toISOString(),
    last_success_at: null,
    last_error_code: null,
    last_error_at: null,
    failures_in_row: 0,
    settings: {},
    ...overrides,
  }
}

/** A Connect stand-in answering the day route per business date. */
function connect(answers: Record<string, () => Response>) {
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const { businessDate } = JSON.parse(init.body as string) as { businessDate: string }
    const answer = answers[businessDate]
    if (!answer) throw new Error(`unexpected fetch for ${businessDate}`)
    return answer()
  })
  return { fetchImpl, deps: { config: CONFIG, fetch: fetchImpl as unknown as typeof fetch } }
}

const ok = (r: PosDayResponse) => () => new Response(JSON.stringify(r), { status: 200 })
const fail = (status: number, code: string, retryable: boolean, retryAfter?: string) => () =>
  new Response(JSON.stringify({ error: 'x', code, retryable }), { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} })

describe('syncPosConnection', () => {
  it('fetches every closed day from sync_from, stores them and moves the cursor over the gapless run', async () => {
    const db = createFakeDb({ pos_connections: [connectionRow()], pos_sales_days: [] })
    const { fetchImpl, deps } = connect({
      '2026-09-30': ok(response('2026-09-30', 1120)),
      '2026-10-01': ok(response('2026-10-01', 2240)),
      '2026-10-02': ok(response('2026-10-02', 3360)),
    })
    const result = await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })
    expect(result).toMatchObject({ status: 'synced', fetched: ['2026-09-30', '2026-10-01', '2026-10-02'] })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const days = db.tables.pos_sales_days
    expect(days.map((d) => [d.business_date, d.status, d.gross, d.fetch_count])).toEqual([
      ['2026-09-30', 'ready', 1120, 1],
      ['2026-10-01', 'ready', 2240, 1],
      ['2026-10-02', 'ready', 3360, 1],
    ])
    expect(days[0].raw_body).toBe('{"d":"2026-09-30","g":1120}')
    const conn = db.tables.pos_connections[0]
    expect(conn).toMatchObject({ synced_through: '2026-10-02', health: 'ok', failures_in_row: 0 })
    // Released, and the next run is the next morning (06:15 Swedish time).
    expect(conn.lease_until).toBe(new Date(0).toISOString())
    expect(conn.next_run_at).toBe('2026-10-04T04:15:00.000Z')
  })

  it('spends at most maxCalls provider calls and comes back for the rest', async () => {
    const db = createFakeDb({ pos_connections: [connectionRow({ sync_from: '2026-09-25' })], pos_sales_days: [] })
    const answers = Object.fromEntries(
      ['2026-09-25', '2026-09-26', '2026-09-27'].map((d) => [d, ok(response(d))]),
    )
    const { fetchImpl, deps } = connect(answers)
    await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps, maxCalls: 3 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const conn = db.tables.pos_connections[0]
    expect(conn.synced_through).toBe('2026-09-27')
    // Days are still missing: a catch-up run an hour later, under the provider's hourly limit.
    expect(conn.next_run_at).toBe(new Date(NOW.getTime() + 60 * 60 * 1000).toISOString())
  })

  it('reads the latest unbooked days once more after 18 hours, and stores a changed answer', async () => {
    const fetchedYesterday = new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString()
    const stored = (date: string) => ({
      id: `day-${date}`,
      company_id: COMPANY,
      connection_id: 'conn-1',
      business_date: date,
      journal_entry_id: null,
      raw_sha256: 'a'.repeat(64),
      fetch_count: 1,
      fetched_at: fetchedYesterday,
      status: 'ready',
    })
    const db = createFakeDb({
      pos_connections: [connectionRow({ synced_through: '2026-10-02' })],
      pos_sales_days: [stored('2026-10-01'), stored('2026-10-02')],
    })
    const { fetchImpl, deps } = connect({
      '2026-10-01': ok(response('2026-10-01', 112, 'a')),
      '2026-10-02': ok(response('2026-10-02', 224, 'b')),
    })
    const result = await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.changed).toEqual(['2026-10-02'])
    const second = db.tables.pos_sales_days.find((d) => d.business_date === '2026-10-02')!
    expect(second).toMatchObject({ gross: 224, fetch_count: 2, raw_sha256: 'b'.repeat(64) })
  })

  it('never rewrites a booked day: a different answer only flags it', async () => {
    const db = createFakeDb({
      pos_connections: [connectionRow({ synced_through: '2026-10-01' })],
      pos_sales_days: [
        {
          id: 'day-1',
          company_id: COMPANY,
          connection_id: 'conn-1',
          business_date: '2026-10-02',
          journal_entry_id: 'je-1',
          raw_sha256: 'a'.repeat(64),
          raw_body: 'original',
          gross: 112,
          fetch_count: 1,
          status: 'booked',
        },
      ],
    })
    const { deps } = connect({ '2026-10-02': ok(response('2026-10-02', 999, 'c')) })
    const result = await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })
    expect(result.changedAfterBooking).toEqual(['2026-10-02'])
    expect(db.tables.pos_sales_days[0]).toMatchObject({
      raw_body: 'original',
      gross: 112,
      changed_after_booking: true,
      latest_raw_sha256: 'c'.repeat(64),
    })
  })

  it('marks the connection action_required when the provider has not opened the venue', async () => {
    const db = createFakeDb({ pos_connections: [connectionRow()], pos_sales_days: [] })
    const { deps } = connect({ '2026-09-30': fail(422, 'CONNECTOR_POS_PROVIDER_ACCESS_DENIED', false) })
    const result = await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })
    expect(result).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_POS_PROVIDER_ACCESS_DENIED' })
    const conn = db.tables.pos_connections[0]
    expect(conn).toMatchObject({ health: 'action_required', health_code: 'CONNECTOR_POS_PROVIDER_ACCESS_DENIED', failures_in_row: 1, synced_through: null })
    expect(conn.lease_until).toBe(new Date(0).toISOString())
  })

  it('degrades and waits out the provider limit, keeping what it fetched before', async () => {
    const db = createFakeDb({ pos_connections: [connectionRow()], pos_sales_days: [] })
    const { deps } = connect({
      '2026-09-30': ok(response('2026-09-30')),
      '2026-10-01': fail(429, 'CONNECTOR_POS_PROVIDER_RATE_LIMITED', true, '1800'),
    })
    const result = await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })
    expect(result.fetched).toEqual(['2026-09-30'])
    const conn = db.tables.pos_connections[0]
    expect(conn).toMatchObject({ health: 'degraded', synced_through: '2026-09-30' })
    expect(conn.next_run_at).toBe(new Date(NOW.getTime() + 1800 * 1000).toISOString())
  })

  it('needs a person after six transient failures in a row', async () => {
    const db = createFakeDb({ pos_connections: [connectionRow({ failures_in_row: 5 })], pos_sales_days: [] })
    const { deps } = connect({ '2026-09-30': fail(502, 'CONNECTOR_POS_PROVIDER_ERROR', true) })
    await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })
    expect(db.tables.pos_connections[0]).toMatchObject({ health: 'action_required', failures_in_row: 6 })
  })

  it('leaves a leased connection alone, and reports an ended one as inactive', async () => {
    const leased = createFakeDb({
      pos_connections: [connectionRow({ lease_until: new Date(NOW.getTime() + 60_000).toISOString() })],
    })
    const { fetchImpl, deps } = connect({})
    expect((await syncPosConnection(leased.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })).status).toBe('locked')
    const ended = createFakeDb({ pos_connections: [connectionRow({ status: 'disconnected' })] })
    expect((await syncPosConnection(ended.client as unknown as SupabaseClient, 'conn-1', { now: NOW, log, connect: deps })).status).toBe('inactive')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("fetches exactly the days a person asks for, never today, and leaves the cursor alone", async () => {
    const db = createFakeDb({ pos_connections: [connectionRow({ synced_through: '2026-10-02' })], pos_sales_days: [] })
    const { fetchImpl, deps } = connect({ '2026-10-01': ok(response('2026-10-01')) })
    const result = await syncPosConnection(db.client as unknown as SupabaseClient, 'conn-1', {
      now: NOW,
      log,
      connect: deps,
      dates: ['2026-10-01', '2026-10-03', '2026-09-01'],
    })
    expect(result.fetched).toEqual(['2026-10-01'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(db.tables.pos_connections[0].synced_through).toBe('2026-10-02')
  })
})

describe('reevaluatePosDays', () => {
  it('re-evaluates unbooked days against new settings', async () => {
    const db = createFakeDb({
      pos_sales_days: [
        { id: 'd1', connection_id: 'conn-1', journal_entry_id: null, status: 'ready', day: day('2026-10-01') },
        { id: 'd2', connection_id: 'conn-1', journal_entry_id: 'je', status: 'booked', day: day('2026-10-02') },
      ],
    })
    const settings = applyPosSalesSettingsPatch(DEFAULT_POS_SALES_SETTINGS, { tender_accounts: { card: null } })
    expect(await reevaluatePosDays(db.client as unknown as SupabaseClient, 'conn-1', settings)).toBe(1)
    expect(db.tables.pos_sales_days[0]).toMatchObject({ status: 'needs_review' })
    expect(db.tables.pos_sales_days[1]).toMatchObject({ status: 'booked' })
  })
})
